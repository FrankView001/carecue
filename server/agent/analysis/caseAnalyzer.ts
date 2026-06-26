// 病例分析工具 case.analyze — v3.0 设计文档 §24
// 输出疑似疾病方向排序（不确诊），每个方向必须有支持依据和反对依据/不确定点。

import { z } from 'zod'
import { defineTool } from '../tools/Tool.ts'
import type { CaseState, Hypothesis, MissingInfo } from '../case/CaseState.ts'
import { blockWhenEmergency, requireSymptoms } from '../tools/ToolGuards.ts'
import { buildAnalyzeCasePrompt } from '../llm/prompts/analyzeCase.prompt.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'
import { caseAnalyzeOutputSchema, type CaseAnalyzeOutput } from './hypothesisSchema.ts'
import { getDomainConfig } from '../symptoms/symptomDomainConfig.ts'

export const caseAnalyzeTool = defineTool({
  name: 'case.analyze',
  description: '基于症状和证据输出疑似疾病方向排序、缺失信息和下一步判断。',
  inputSchema: z.object({}),
  outputSchema: caseAnalyzeOutputSchema,
  guardLevel: 'medical_reasoning',
  timeoutMs: 40000,

  guard(_input, state) {
    const emergency = blockWhenEmergency(state)
    if (!emergency.allowed) return emergency
    return requireSymptoms(state)
  },

  async call(_input, ctx) {
    try {
      const prompt = buildAnalyzeCasePrompt(ctx.state)
      const result = await ctx.llm.structured({
        schema: caseAnalyzeOutputSchema,
        schemaName: 'case_analyze',
        system: prompt.system,
        user: prompt.user,
        temperature: 0.2,
        trace: { traceLogger: ctx.traceLogger, caseId: ctx.caseId, node: 'case.analyze' },
      })
      return sanitizeAnalysis(result, ctx.state)
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.traceLogger.log(ctx.caseId, 'llm_fallback', { reason: 'case.analyze 使用症状域种子降级' })
      ctx.markFallback('case.analyze: LLM 不可用，使用症状域种子降级，结论标注为低置信参考')
      return fallbackAnalysis(ctx.state)
    }
  },

  toStatePatch(output): Partial<CaseState> {
    return {
      hypotheses: output.hypotheses as Hypothesis[],
      missingInfo: output.missingInfo.map((m) => ({
        ...m,
        relatedHypothesis: m.relatedHypothesis ?? undefined,
        relatedRiskRule: m.relatedRiskRule ?? undefined,
      })) as MissingInfo[],
    }
  },

  toTrace(output) {
    return {
      output: {
        hypotheses: output.hypotheses.map((h) => `${h.name}(${h.likelihood})`),
        stageConclusion: output.stageConclusion,
      },
    }
  },
})

/** 代码侧约束：最多 3 个主要方向 + must_rule_out；每个方向必须有反对依据或不确定点 */
function sanitizeAnalysis(output: CaseAnalyzeOutput, state: CaseState): CaseAnalyzeOutput {
  const mustRuleOut = output.hypotheses.filter((h) => h.likelihood === 'must_rule_out')
  const others = output.hypotheses.filter((h) => h.likelihood !== 'must_rule_out').slice(0, 3)

  const hypotheses = [...others, ...mustRuleOut].map((h) => {
    if (h.againstEvidence.length === 0 && h.missingInfo.length === 0) {
      return { ...h, missingInfo: ['当前信息不足以排除其他方向，需要医生面诊确认。'] }
    }
    return h
  })

  // 没有任何证据时不允许 canFinalAnswer（§8.3 final_answer 选择条件）
  const canFinalAnswer = output.canFinalAnswer && state.evidence.length > 0

  return { ...output, hypotheses, canFinalAnswer }
}

/** LLM 不可用时：用症状域种子生成低置信方向 */
function fallbackAnalysis(state: CaseState): CaseAnalyzeOutput {
  const config = getDomainConfig(state.symptomDomain.primaryDomain)
  const seeds = config?.commonHypothesisSeeds.slice(0, 3) ?? ['需线下评估的不适方向']

  return {
    hypotheses: seeds.map((name, index) => ({
      name,
      likelihood: index === 0 ? 'possible' : 'less_likely',
      supportEvidence: [`症状域 ${state.symptomDomain.primaryDomain} 的常见方向之一`],
      againstEvidence: [],
      missingInfo: ['AI 分析暂不可用，本方向仅为该症状域常见参考，不构成判断。'],
      riskLevel: 'medium',
      doctorCheckQuestion: `请医生评估是否为${name}。`,
      explanationForUser: `根据症状类型，${name}是该类不适的常见方向之一，需要医生进一步确认。`,
      evidenceRefs: [],
    })),
    missingInfo: [],
    stageConclusion: 'AI 分析暂不可用，仅提供该症状域常见方向作低置信参考，建议线下确认。',
    canFinalAnswer: false,
    shouldAskUser: false,
    shouldSearchMore: false,
    shouldGenerateCarePlan: false,
  }
}
