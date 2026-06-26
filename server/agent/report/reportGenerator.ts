// 最终报告生成工具 report.generate — v3.0 设计文档 §27 / §31.10

import { z } from 'zod'
import { defineTool } from '../tools/Tool.ts'
import { blockWhenEmergency } from '../tools/ToolGuards.ts'
import { buildGenerateReportPrompt } from '../llm/prompts/generateReport.prompt.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'
import { finalReportSchema, type FinalReport } from './reportSchema.ts'
import type { CaseState } from '../case/CaseState.ts'

const inputSchema = z.object({
  reportType: z.enum(['final', 'stage']),
  guardIssues: z.array(z.string()).optional(),
})

export const reportGenerateTool = defineTool({
  name: 'report.generate',
  description: '按固定 12 段结构生成就医前症状处理报告草稿。',
  inputSchema,
  outputSchema: finalReportSchema,
  guardLevel: 'medical_output',
  timeoutMs: 50000,

  guard(_input, state) {
    return blockWhenEmergency(state)
  },

  async call(input, ctx) {
    try {
      const prompt = buildGenerateReportPrompt(ctx.state, input.guardIssues)
      return await ctx.llm.structured({
        schema: finalReportSchema,
        schemaName: 'final_report',
        system: prompt.system,
        user: prompt.user,
        temperature: 0.2,
        trace: { traceLogger: ctx.traceLogger, caseId: ctx.caseId, node: 'report.generate' },
      })
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.traceLogger.log(ctx.caseId, 'llm_fallback', { reason: 'report.generate 使用模板降级' })
      ctx.markFallback('report.generate: LLM 不可用，使用 CaseState 模板拼装报告')
      return buildTemplateReport(ctx.state)
    }
  },

  toTrace(output) {
    return {
      output: {
        conclusion: output.currentConclusion.slice(0, 100),
        hypotheses: output.hypotheses.map((h) => h.name),
      },
    }
  },
})

/** 模板降级报告：直接由 CaseState 拼装，不经过 LLM */
export function buildTemplateReport(state: CaseState): FinalReport {
  const carePlan = state.carePlan

  return {
    currentConclusion:
      state.hypotheses.length > 0
        ? `根据目前信息，更像「${state.hypotheses[0].name}」方向，但还不能确诊，需要结合线下检查确认。${
            state.missingInfo.length > 0 ? '当前信息还不完整，结论为阶段性判断。' : ''
          }`
        : '当前信息不足以形成疾病方向判断，以下为阶段性整理。',
    riskLevel: state.risk.level,
    riskReason: state.risk.reason,
    deniedRedFlags: state.riskProbe.redFlagDenied,
    unresolvedRedFlags: state.riskProbe.unresolvedRedFlags,
    hypotheses: state.hypotheses.map((h) => ({
      name: h.name,
      likelihood: h.likelihood,
      supportEvidence: h.supportEvidence,
      againstEvidence: h.againstEvidence,
      uncertainties: h.missingInfo,
    })),
    selfCareAdvice: carePlan?.selfCareAdvice ?? ['保持休息，记录症状变化，为就诊做准备。'],
    otcIngredientOptions: (carePlan?.otcIngredientOptions ?? []).map((o) => ({
      ingredientCategory: o.ingredientCategory,
      suitableFor: o.suitableFor,
      caution: o.caution,
    })),
    avoidActions: carePlan?.avoidActions ?? [],
    seekCareWhen: carePlan?.seekCareWhen ?? ['症状加重、持续不缓解或出现新的明显不适时尽快就医。'],
    departmentSuggestion: carePlan?.departmentSuggestion ?? '可先到全科/相应专科门诊评估。',
    questionsForDoctor: state.hypotheses.map((h) => h.doctorCheckQuestion).filter(Boolean),
    doctorSummary: buildDoctorSummary(state),
    uncertaintyNote:
      carePlan?.uncertaintyNote ?? '以上为就医前信息整理，不是诊断结论，线上信息无法替代医生面诊和检查。',
    references: state.evidence.map((e) => ({ title: e.sourceTitle, url: e.sourceUrl })),
  }
}

export function buildDoctorSummary(state: CaseState): string {
  const s = state.symptoms
  const lines = [
    `主诉：${s.chiefComplaint || '未明确'}`,
    s.duration ? `病程：${s.duration}` : '',
    s.location ? `部位：${s.location}` : '',
    s.severity ? `严重程度：${s.severity}` : '',
    s.triggers?.length ? `诱因：${s.triggers.join('、')}` : '',
    s.relievingFactors?.length ? `缓解因素：${s.relievingFactors.join('、')}` : '',
    s.associatedSymptoms?.length ? `伴随症状：${s.associatedSymptoms.join('、')}` : '',
    s.negativeSymptoms?.length ? `否认症状：${s.negativeSymptoms.join('、')}` : '',
    state.risk.redFlags.length ? `已出现的风险信号：${state.risk.redFlags.join('；')}` : '',
    state.hypotheses.length
      ? `AI 整理的疑似方向：${state.hypotheses.map((h) => `${h.name}（${likelihoodLabel(h.likelihood)}）`).join('、')}`
      : '',
    state.hypotheses.length
      ? `希望医生确认或排除：${state.hypotheses.map((h) => h.doctorCheckQuestion).filter(Boolean).join('；')}`
      : '',
  ]
  return lines.filter(Boolean).join('\n')
}

function likelihoodLabel(likelihood: string): string {
  return (
    {
      more_likely: '更像',
      possible: '可能',
      less_likely: '暂不太支持',
      must_rule_out: '需优先排除',
    }[likelihood] ?? likelihood
  )
}
