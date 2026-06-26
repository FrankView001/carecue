// 证据抽取 — v3.0 设计文档 §22.1 / §31.6
// 只能从 accepted sources 抽取；LLM 不可用时降级为摘要式证据（低可信，仅 summary）。

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CaseState } from '../case/CaseState.ts'
import type { LlmClient } from '../llm/llmClient.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'
import { buildExtractEvidencePrompt } from '../llm/prompts/extractEvidence.prompt.ts'
import type { FetchedPage } from '../search/sourceFetcher.ts'
import { extractedFactsSchema, applicableToSchema, type MedicalEvidence } from './evidenceSchema.ts'
import type { TraceLogger } from '../logs/traceLogger.ts'

const llmEvidenceSchema = z.object({
  relatedHypotheses: z.array(z.string()),
  extractedFacts: extractedFactsSchema,
  applicableTo: applicableToSchema,
  summary: z.string(),
  relevant: z.boolean(),
})

export async function extractEvidenceFromPage(
  page: FetchedPage,
  state: CaseState,
  llm: LlmClient,
  traceLogger?: TraceLogger,
): Promise<MedicalEvidence | null> {
  try {
    const prompt = buildExtractEvidencePrompt(
      { title: page.source.title, url: page.source.url, markdown: page.markdown },
      state,
    )
    const result = await llm.structured({
      schema: llmEvidenceSchema,
      schemaName: 'evidence_extraction',
      system: prompt.system,
      user: prompt.user,
      trace: traceLogger ? { traceLogger, caseId: state.caseId, node: 'evidence.extract' } : undefined,
    })

    // 与当前症状无关的证据不进入上下文（§23）
    if (!result.relevant) return null

    return {
      id: randomUUID(),
      sourceTitle: page.source.title,
      sourceUrl: page.source.url,
      sourceDomain: page.source.domain,
      credibility: page.source.credibility,
      sourceType: page.source.sourceType,
      relatedDomain: page.source.task.relatedDomain,
      relatedHypotheses: result.relatedHypotheses,
      extractedFacts: result.extractedFacts,
      applicableTo: result.applicableTo,
      summary: result.summary.slice(0, 400),
      extractedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (!(error instanceof LlmUnavailableError)) throw error
    traceLogger?.log(state.caseId, 'llm_fallback', { reason: 'evidence.extract: LLM 不可用，仅保留原文摘要降级' })
    // 降级：仅保留摘要，不提取结构化医学事实
    return {
      id: randomUUID(),
      sourceTitle: page.source.title,
      sourceUrl: page.source.url,
      sourceDomain: page.source.domain,
      credibility: page.source.credibility,
      sourceType: page.source.sourceType,
      relatedDomain: page.source.task.relatedDomain,
      relatedHypotheses: page.source.task.relatedHypothesis ? [page.source.task.relatedHypothesis] : [],
      extractedFacts: {},
      applicableTo: {},
      summary: page.markdown.slice(0, 300),
      extractedAt: new Date().toISOString(),
    }
  }
}
