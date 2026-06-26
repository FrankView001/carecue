// 处理建议生成工具 care_plan.generate — v3.0 设计文档 §25
// 覆盖：日常护理 / 生活方式 / 成分级用药边界 / 避免事项 / 何时就医 / 科室。

import { z } from 'zod'
import { defineTool } from '../tools/Tool.ts'
import type { CarePlan, CaseState } from '../case/CaseState.ts'
import { requireHypothesesAndEvidence } from '../tools/ToolGuards.ts'
import { buildGenerateCarePlanPrompt } from '../llm/prompts/generateCarePlan.prompt.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'

export const carePlanOutputSchema = z.object({
  selfCareAdvice: z.array(z.string()).min(1),
  lifestyleAdvice: z.array(z.string()),
  otcIngredientOptions: z.array(
    z.object({
      ingredientCategory: z.string(),
      suitableFor: z.string(),
      caution: z.string(),
      evidenceRefs: z.array(z.string()),
    }),
  ),
  avoidActions: z.array(z.string()),
  seekCareWhen: z.array(z.string()).min(1),
  departmentSuggestion: z.string(),
  followupWindow: z.string(),
  uncertaintyNote: z.string(),
})

export const carePlanGenerateTool = defineTool({
  name: 'care_plan.generate',
  description: '基于疑似方向和证据生成日常处理建议与成分级用药边界。',
  inputSchema: z.object({}),
  outputSchema: carePlanOutputSchema,
  guardLevel: 'medical_output',
  timeoutMs: 40000,

  guard(_input, state) {
    return requireHypothesesAndEvidence(state)
  },

  async call(_input, ctx) {
    try {
      const prompt = buildGenerateCarePlanPrompt(ctx.state)
      return await ctx.llm.structured({
        schema: carePlanOutputSchema,
        schemaName: 'care_plan',
        system: prompt.system,
        user: prompt.user,
        temperature: 0.2,
        trace: { traceLogger: ctx.traceLogger, caseId: ctx.caseId, node: 'care_plan.generate' },
      })
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.traceLogger.log(ctx.caseId, 'llm_fallback', { reason: 'care_plan.generate 使用证据直出降级' })
      ctx.markFallback('care_plan.generate: LLM 不可用，直接汇总证据原文作为护理建议')
      return fallbackCarePlan(ctx.state)
    }
  },

  toStatePatch(output): Partial<CaseState> {
    const carePlan: CarePlan = {
      ...output,
      departmentSuggestion: output.departmentSuggestion || undefined,
      followupWindow: output.followupWindow || undefined,
    }
    return { carePlan }
  },

  toTrace(output) {
    return {
      output: {
        selfCare: output.selfCareAdvice.length,
        otcIngredients: output.otcIngredientOptions.map((o) => o.ingredientCategory),
        seekCareWhen: output.seekCareWhen.length,
      },
    }
  },
})

/** LLM 不可用时：直接汇总证据中的护理建议（不加工，不编造） */
function fallbackCarePlan(state: CaseState): z.infer<typeof carePlanOutputSchema> {
  const selfCare = dedupe(state.evidence.flatMap((e) => e.extractedFacts.selfCareAdvice ?? []))
  const seekCare = dedupe(state.evidence.flatMap((e) => e.extractedFacts.whenToSeekCare ?? []))
  const avoid = dedupe(state.evidence.flatMap((e) => e.extractedFacts.avoidActions ?? []))
  const departments = dedupe(state.evidence.flatMap((e) => e.extractedFacts.recommendedDepartment ?? []))

  return {
    selfCareAdvice: selfCare.length > 0 ? selfCare.slice(0, 5) : ['保持休息和观察，记录症状变化（时间、程度、诱因），为就诊做准备。'],
    lifestyleAdvice: [],
    otcIngredientOptions: [],
    avoidActions: avoid.slice(0, 5),
    seekCareWhen:
      seekCare.length > 0
        ? seekCare.slice(0, 5)
        : ['症状加重、持续不缓解、出现新的明显不适时，应尽快就医。'],
    departmentSuggestion: departments[0] ?? '',
    followupWindow: '',
    uncertaintyNote: 'AI 建议生成暂不可用，以上内容来自权威来源原文摘录，具体处理请以医生意见为准。',
  }
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}
