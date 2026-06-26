// 症状域识别工具 symptom.domain_classify — v3.0 设计文档 §9 / §31.2
// 代码触发词匹配优先（确定性），无法识别时才用 LLM，再不行输出 unknown。

import { z } from 'zod'
import { defineTool } from '../tools/Tool.ts'
import type { CaseState } from '../case/CaseState.ts'
import { SYMPTOM_DOMAINS, type SymptomDomain } from './symptomDomain.ts'
import { SYMPTOM_DOMAIN_CONFIGS, getDomainConfig } from './symptomDomainConfig.ts'
import { normalizeSymptomText } from './symptomNormalizer.ts'
import { buildClassifySymptomDomainPrompt } from '../llm/prompts/classifySymptomDomain.prompt.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'

const inputSchema = z.object({})

const outputSchema = z.object({
  primaryDomain: z.enum(SYMPTOM_DOMAINS),
  secondaryDomains: z.array(z.enum(SYMPTOM_DOMAINS)),
  triggerTerms: z.array(z.string()),
  supportedDepth: z.enum(['full', 'red_flag_only']),
  reason: z.string(),
})

export type SymptomDomainClassifyOutput = z.infer<typeof outputSchema>

export const symptomDomainClassifyTool = defineTool({
  name: 'symptom.domain_classify',
  description: '识别症状域。症状域只决定下一步问什么、搜什么，不决定风险等级。',
  inputSchema,
  outputSchema,
  guardLevel: 'safe_read',
  timeoutMs: 20000,

  async call(_input, ctx) {
    const byTrigger = classifyByTriggerTerms(ctx.state)
    if (byTrigger.primaryDomain !== 'unknown') {
      return byTrigger
    }

    try {
      const prompt = buildClassifySymptomDomainPrompt(ctx.state)
      const llmResult = await ctx.llm.structured({
        schema: outputSchema,
        schemaName: 'symptom_domain_classify',
        system: prompt.system,
        user: prompt.user,
        trace: { traceLogger: ctx.traceLogger, caseId: ctx.caseId, node: 'symptom.domain_classify' },
      })
      const config = getDomainConfig(llmResult.primaryDomain)
      return {
        ...llmResult,
        supportedDepth: config?.supportedDepth ?? 'red_flag_only',
      }
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.markFallback('symptom_domain_classify: LLM 不可用，使用触发词匹配结果降级')
      return byTrigger
    }
  },

  toStatePatch(output): Partial<CaseState> {
    return {
      symptomDomain: {
        primaryDomain: output.primaryDomain,
        secondaryDomains: output.secondaryDomains,
        triggerTerms: output.triggerTerms,
        supportedDepth: output.supportedDepth,
        reason: output.reason,
      },
    }
  },

  toTrace(output) {
    return { output, reason: `症状域：${output.primaryDomain}` }
  },
})

export function classifyByTriggerTerms(state: CaseState): SymptomDomainClassifyOutput {
  const text = normalizeSymptomText(
    [state.symptoms.chiefComplaint, ...state.symptoms.userOriginalText, ...(state.symptoms.associatedSymptoms ?? [])].join(' '),
  )

  const matches: Array<{ domain: SymptomDomain; terms: string[]; depth: 'full' | 'red_flag_only' }> = []

  for (const config of SYMPTOM_DOMAIN_CONFIGS) {
    const terms = config.triggerTerms.filter((term) => text.includes(term))
    if (terms.length > 0) {
      matches.push({ domain: config.domain, terms, depth: config.supportedDepth })
    }
  }

  if (matches.length === 0) {
    return {
      primaryDomain: 'unknown',
      secondaryDomains: [],
      triggerTerms: [],
      supportedDepth: 'red_flag_only',
      reason: '未匹配到任何症状域触发词。',
    }
  }

  // 高风险域（红旗拦截域）优先作为 primary：SYMPTOM_DOMAIN_CONFIGS 已按优先级排序
  const [primary, ...rest] = matches
  return {
    primaryDomain: primary.domain,
    secondaryDomains: rest.map((m) => m.domain),
    triggerTerms: matches.flatMap((m) => m.terms),
    supportedDepth: primary.depth,
    reason: `触发词匹配：${primary.terms.join('、')}`,
  }
}
