// 追问生成工具 — v3.0 设计文档 §26 / §31.4 / §31.9
// 两种模式：risk_probe（风险核查）/ differential（鉴别 + 处理建议）。
// LLM 不可用时直接使用症状域配置的核查问题或 missingInfo。

import { z } from 'zod'
import { defineTool } from '../tools/Tool.ts'
import type { FollowupQuestion } from '../case/CaseState.ts'
import { buildGenerateRiskProbePrompt } from '../llm/prompts/generateRiskProbe.prompt.ts'
import { buildGenerateFollowupPrompt } from '../llm/prompts/generateFollowup.prompt.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'

const followupQuestionSchema = z.object({
  question: z.string(),
  reason: z.string(),
  targetField: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  relatedHypothesis: z.string().nullable().optional(),
  relatedRiskRule: z.string().nullable().optional(),
  type: z.enum(['risk_probe', 'differential', 'care_plan']),
})

const followupOutputSchema = z.object({
  intro: z.string(),
  questions: z.array(followupQuestionSchema).min(1).max(5),
})

export type FollowupOutput = {
  intro: string
  questions: FollowupQuestion[]
}

function toQuestions(output: z.infer<typeof followupOutputSchema>): FollowupOutput {
  return {
    intro: output.intro,
    questions: output.questions.map((q) => ({
      ...q,
      relatedHypothesis: q.relatedHypothesis ?? undefined,
      relatedRiskRule: q.relatedRiskRule ?? undefined,
    })),
  }
}

export const riskProbeQuestionTool = defineTool({
  name: 'question.generate_risk_probe',
  description: '生成风险核查追问（确认危险信号，不判定危险）。',
  inputSchema: z.object({}),
  outputSchema: followupOutputSchema,
  guardLevel: 'medical_output',
  timeoutMs: 30000,

  async call(_input, ctx) {
    const state = ctx.state
    try {
      const prompt = buildGenerateRiskProbePrompt(state)
      const result = await ctx.llm.structured({
        schema: followupOutputSchema,
        schemaName: 'risk_probe_questions',
        system: prompt.system,
        user: prompt.user,
        temperature: 0.2,
        trace: { traceLogger: ctx.traceLogger, caseId: ctx.caseId, node: 'question.generate_risk_probe' },
      })
      return result
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.markFallback('question.generate_risk_probe: LLM 不可用，使用症状域配置的核查问题降级')
      // 降级：直接用症状域配置的核查问题
      return {
        intro: '你提到的症状需要先确认是否存在危险信号。目前信息还不足，不能直接判断为急症，也不能直接归因于疲劳或熬夜。请先确认：',
        questions: state.riskProbe.requiredQuestions.slice(0, 3).map((q) => ({
          ...q,
          relatedHypothesis: q.relatedHypothesis ?? null,
          relatedRiskRule: q.relatedRiskRule ?? null,
        })),
      }
    }
  },

  toTrace(output) {
    return { output: output.questions.map((q) => q.question) }
  },
})

export const followupQuestionTool = defineTool({
  name: 'question.generate',
  description: '生成鉴别 / 处理建议追问。',
  inputSchema: z.object({}),
  outputSchema: followupOutputSchema,
  guardLevel: 'medical_output',
  timeoutMs: 30000,

  async call(_input, ctx) {
    const state = ctx.state
    try {
      const prompt = buildGenerateFollowupPrompt(state)
      return await ctx.llm.structured({
        schema: followupOutputSchema,
        schemaName: 'followup_questions',
        system: prompt.system,
        user: prompt.user,
        temperature: 0.2,
        trace: { traceLogger: ctx.traceLogger, caseId: ctx.caseId, node: 'question.generate' },
      })
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.markFallback('question.generate: LLM 不可用，使用 missingInfo 转追问降级')
      // 降级：用 missingInfo 转追问
      const questions = state.missingInfo.slice(0, 3).map((m) => ({
        question: m.question,
        reason: m.reason,
        targetField: m.field,
        priority: m.priority,
        relatedHypothesis: m.relatedHypothesis ?? null,
        relatedRiskRule: m.relatedRiskRule ?? null,
        type: 'differential' as const,
      }))
      if (questions.length === 0) {
        throw new Error('没有可用的追问（missingInfo 为空且 LLM 不可用）', { cause: error })
      }
      return { intro: '为了区分几个可能方向，需要确认：', questions }
    }
  },

  toTrace(output) {
    return { output: output.questions.map((q) => q.question) }
  },
})

export { toQuestions }
