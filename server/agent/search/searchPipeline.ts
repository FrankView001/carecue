// SearchPipeline 并发搜索管线 — v3.0 设计文档 §20
// 并发只用于搜索、抓取、证据抽取；CaseState 更新由 agentLoop 串行执行。

import { randomUUID } from 'node:crypto'
import type { CaseState } from '../case/CaseState.ts'
import type { MedicalSearchTask } from '../actionSchema.ts'
import type { ToolResultMessage } from '../messages/AgentMessage.ts'
import type { TraceLogger } from '../logs/traceLogger.ts'
import type { LlmClient } from '../llm/llmClient.ts'
import type { AgentFailureCode } from '../failureRecovery.ts'
import type { SearchClient, RawSearchHit } from './medicalSearchTool.ts'
import { searchTaskNormalizer } from './searchTaskNormalizer.ts'
import { filterSources } from './sourceFilter.ts'
import { fetchSourcePage, type FetchedPage } from './sourceFetcher.ts'
import { extractEvidenceFromPage } from '../evidence/evidenceExtractor.ts'
import { evidenceValidator } from '../evidence/evidenceValidator.ts'
import { evidenceAggregator } from '../evidence/evidenceAggregator.ts'
import { createLimiter, collectSuccessful, PIPELINE_CONCURRENCY } from './concurrency.ts'
import { AGENT_LIMITS } from '../agentLimits.ts'
import type { MedicalEvidence } from '../evidence/evidenceSchema.ts'

export type SearchPipelineResult =
  | {
      status: 'success'
      message: ToolResultMessage
      statePatch: Partial<CaseState>
    }
  | {
      status: 'error'
      failureCode: AgentFailureCode
      message: ToolResultMessage
      statePatch: Partial<CaseState>
      debugPayload?: unknown
    }

export class SearchPipeline {
  constructor(
    private search: SearchClient,
    private llm: LlmClient,
    private traceLogger: TraceLogger,
  ) {}

  async run(input: { tasks: MedicalSearchTask[]; state: CaseState }): Promise<SearchPipelineResult> {
    const { state } = input
    const caseId = state.caseId

    const normalizedTasks = searchTaskNormalizer.normalize(input.tasks, state)
    this.traceLogger.log(caseId, 'search_queries', {
      output: normalizedTasks.map((t) => ({ query: t.query, purpose: t.purpose })),
    })

    if (normalizedTasks.length === 0) {
      return this.fail(caseId, 'SEARCH_NO_RESULT', '没有生成检索 query（query generation 为空）。', normalizedTasks)
    }

    // 1. 并发搜索（逐个 task 记录完整请求/响应，区分接口报错 vs 接口返回空 vs 超时）
    const searchLimit = createLimiter(PIPELINE_CONCURRENCY.search)
    const searchSettled = await Promise.allSettled(
      normalizedTasks.map((task) =>
        searchLimit(async () => {
          const startedAt = Date.now()
          try {
            const hits = await this.search.search(task)
            this.traceLogger.logSearchCall(caseId, {
              node: 'search.firecrawl',
              query: task.query,
              purpose: task.purpose,
              provider: 'firecrawl',
              requestParams: { preferredSources: task.preferredSources, language: task.language },
              rawCount: hits.length,
              durationMs: Date.now() - startedAt,
              status: hits.length > 0 ? 'success' : 'failed',
              failureReason: hits.length === 0 ? '接口返回为空（无结果）' : undefined,
            })
            return hits
          } catch (error) {
            const isTimeout = /timeout|ETIMEDOUT|ECONNABORTED/i.test(String(error))
            this.traceLogger.logSearchCall(caseId, {
              node: 'search.firecrawl',
              query: task.query,
              purpose: task.purpose,
              provider: 'firecrawl',
              requestParams: { preferredSources: task.preferredSources, language: task.language },
              durationMs: Date.now() - startedAt,
              status: 'failed',
              failureReason: isTimeout ? '请求超时' : '搜索接口报错',
              error: { message: String(error) },
            })
            throw error
          }
        }),
      ),
    )
    const rawResults: RawSearchHit[] = collectSuccessful(searchSettled).flat()
    const searchErrors = searchSettled.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))

    if (rawResults.length === 0) {
      const allFailed = searchErrors.length === normalizedTasks.length && normalizedTasks.length > 0
      return this.fail(
        caseId,
        'SEARCH_NO_RESULT',
        allFailed ? `搜索接口报错：${searchErrors.join('; ')}` : '联网搜索接口返回为空（无结果）。',
        normalizedTasks,
        { searchErrors },
      )
    }

    // 2. 来源过滤
    const filtered = filterSources(rawResults)
    this.traceLogger.log(caseId, 'sources_accepted', {
      output: filtered.accepted.map((s) => ({ url: s.url, credibility: s.credibility })),
    })
    this.traceLogger.log(caseId, 'sources_rejected', {
      output: filtered.rejected,
    })

    if (filtered.accepted.length === 0) {
      return this.fail(caseId, 'ALL_SOURCES_REJECTED', '结果被白名单过滤为空（所有来源都被过滤，低质量来源）。', normalizedTasks, {
        rejected: filtered.rejected,
      })
    }

    const acceptedSources = filtered.accepted.slice(0, AGENT_LIMITS.maxAcceptedSources)

    // 3. 并发抓取
    const fetchLimit = createLimiter(PIPELINE_CONCURRENCY.fetch)
    const fetchedSettled = await Promise.allSettled(
      acceptedSources.map((source) => fetchLimit(() => fetchSourcePage(source, this.search))),
    )
    const fetchedPages = collectSuccessful(fetchedSettled).filter(
      (page): page is FetchedPage => page !== null,
    )

    // 4. 并发证据抽取
    const extractLimit = createLimiter(PIPELINE_CONCURRENCY.evidenceExtract)
    const evidenceSettled = await Promise.allSettled(
      fetchedPages.map((page) =>
        extractLimit(() => extractEvidenceFromPage(page, state, this.llm, this.traceLogger)),
      ),
    )
    const extractedEvidence = collectSuccessful(evidenceSettled).filter(
      (item): item is MedicalEvidence => item !== null,
    )

    if (extractedEvidence.length === 0) {
      return this.fail(caseId, 'EVIDENCE_EMPTY', '结果解析失败：未能从来源中抽取有效证据（页面内容与症状无关或抽取失败）。', normalizedTasks)
    }

    // 5. 校验 + 聚合
    const validated = evidenceValidator.validate(extractedEvidence)
    const aggregated = evidenceAggregator.merge(validated.valid)

    if (aggregated.evidence.length === 0) {
      return this.fail(caseId, 'EVIDENCE_EMPTY', '证据校验后为空。', normalizedTasks)
    }

    this.traceLogger.log(caseId, 'evidence_extracted', {
      output: aggregated.evidence.map((e) => ({
        url: e.sourceUrl,
        credibility: e.credibility,
        summary: e.summary.slice(0, 80),
      })),
      reason: `dropped: ${aggregated.droppedEvidence.length + validated.dropped.length}`,
    })

    const statePatch: Partial<CaseState> = {
      evidence: aggregated.evidence,
      searchTrace: normalizedTasks.map((t) => ({
        query: t.query,
        purpose: t.purpose,
        status: 'ok' as const,
        sourceCount: acceptedSources.length,
        at: new Date().toISOString(),
      })),
      meta: {
        ...state.meta,
        searchRounds: state.meta.searchRounds + 1,
      },
    }

    return {
      status: 'success',
      message: {
        toolUseId: randomUUID(),
        toolName: 'search.pipeline',
        status: 'success',
        output: {
          acceptedSources: acceptedSources.map((s) => ({ title: s.title, url: s.url, credibility: s.credibility })),
          rejectedSources: filtered.rejected,
          evidenceCount: aggregated.evidence.length,
        },
        statePatch,
        createdAt: new Date().toISOString(),
      },
      statePatch,
    }
  }

  private fail(
    caseId: string,
    failureCode: AgentFailureCode,
    reason: string,
    tasks: MedicalSearchTask[] = [],
    debugPayload?: unknown,
  ): SearchPipelineResult {
    this.traceLogger.log(caseId, 'failure_recovery', { reason: `${failureCode}: ${reason}`, output: debugPayload })
    const failStatus =
      failureCode === 'ALL_SOURCES_REJECTED' ? ('rejected' as const)
      : failureCode === 'SEARCH_NO_RESULT' ? ('no_result' as const)
      : ('error' as const)
    return {
      status: 'error',
      failureCode,
      debugPayload,
      message: {
        toolUseId: randomUUID(),
        toolName: 'search.pipeline',
        status: 'error',
        error: { code: failureCode, message: reason, recoverable: true },
        createdAt: new Date().toISOString(),
      },
      statePatch: {
        searchTrace: tasks.map((t) => ({
          query: t.query,
          purpose: t.purpose,
          status: failStatus,
          sourceCount: 0,
          at: new Date().toISOString(),
        })),
      },
    }
  }
}
