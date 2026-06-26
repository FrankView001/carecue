// 搜索任务生成 — v3.0 设计文档 §19 / §31.5
// LLM 生成检索任务；LLM 不可用时回落到症状域配置中的检索模板。

import { z } from 'zod'
import type { CaseState } from '../case/CaseState.ts'
import type { MedicalSearchTask } from '../actionSchema.ts'
import { medicalSearchTaskSchema } from '../actionSchema.ts'
import type { LlmClient } from '../llm/llmClient.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'
import { buildGenerateSearchTasksPrompt } from '../llm/prompts/generateSearchTasks.prompt.ts'
import { getDomainConfig } from '../symptoms/symptomDomainConfig.ts'
import type { TraceLogger } from '../logs/traceLogger.ts'

const searchTasksOutputSchema = z.object({
  tasks: z.array(medicalSearchTaskSchema),
})

export async function generateSearchTasks(
  state: CaseState,
  decisionGoal: string,
  llm: LlmClient,
  traceLogger?: TraceLogger,
): Promise<MedicalSearchTask[]> {
  try {
    const prompt = buildGenerateSearchTasksPrompt(state, decisionGoal)
    const result = await llm.structured({
      schema: searchTasksOutputSchema,
      schemaName: 'search_tasks',
      system: prompt.system,
      user: prompt.user,
      trace: traceLogger ? { traceLogger, caseId: state.caseId, node: 'search.generate_tasks' } : undefined,
    })
    return result.tasks
  } catch (error) {
    if (!(error instanceof LlmUnavailableError)) throw error
    traceLogger?.log(state.caseId, 'llm_fallback', { reason: 'search.generate_tasks: LLM 不可用，使用症状域检索模板降级' })
    return buildTemplateSearchTasks(state)
  }
}

/** 降级：使用症状域配置中的检索模板 */
export function buildTemplateSearchTasks(state: CaseState): MedicalSearchTask[] {
  const config = getDomainConfig(state.symptomDomain.primaryDomain)
  if (!config) return []

  const seedHypothesis = state.hypotheses[0]?.name ?? config.commonHypothesisSeeds[0]

  return config.searchQueryTemplates.map((template) => ({
    query: template.query,
    purpose: template.purpose,
    preferredSources: template.preferredSources,
    language: template.language,
    relatedDomain: config.domain,
    relatedHypothesis: seedHypothesis,
  }))
}
