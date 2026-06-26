// 症状抽取工具 symptom.extract — v3.0 设计文档 §31.1
// LLM 抽取为主；LLM 不可用时降级为词典 + 规则抽取（TECHNICAL.md fallback 要求）。

import { z } from 'zod'
import { defineTool } from '../tools/Tool.ts'
import type { CaseState, SymptomState, UserProfile } from '../case/CaseState.ts'
import { buildUnderstandSymptomsPrompt } from '../llm/prompts/understandSymptoms.prompt.ts'
import { LlmUnavailableError } from '../llm/llmClient.ts'
import {
  extractDurationText,
  extractTermsByDictionary,
  normalizeSymptomText,
} from './symptomNormalizer.ts'
import { SYMPTOM_DOMAIN_CONFIGS } from './symptomDomainConfig.ts'

const symptomExtractInputSchema = z.object({
  userMessage: z.string().min(1),
})

const symptomExtractOutputSchema = z.object({
  chiefComplaint: z.string(),
  onsetTime: z.string(),
  duration: z.string(),
  location: z.string(),
  severity: z.string(),
  frequency: z.string(),
  painQuality: z.string(),
  onsetPattern: z.string(),
  triggers: z.array(z.string()),
  relievingFactors: z.array(z.string()),
  associatedSymptoms: z.array(z.string()),
  negativeSymptoms: z.array(z.string()),
  progression: z.enum(['improving', 'stable', 'worsening', 'unknown']),
  age: z.number().nullable(),
  sex: z.enum(['male', 'female', 'unknown']),
  pregnancy: z.boolean().nullable(),
  chronicDiseases: z.array(z.string()),
  currentMedications: z.array(z.string()),
  unclearFields: z.array(z.string()),
  userOriginalText: z.string(),
})

export type SymptomExtractOutput = z.infer<typeof symptomExtractOutputSchema>

export const symptomExtractTool = defineTool({
  name: 'symptom.extract',
  description: '从用户最新消息中抽取症状结构化信息（不诊断、不建议）。',
  inputSchema: symptomExtractInputSchema,
  outputSchema: symptomExtractOutputSchema,
  guardLevel: 'medical_reasoning',
  timeoutMs: 30000,

  async call(input, ctx) {
    const userMessage = input.userMessage

    try {
      const prompt = buildUnderstandSymptomsPrompt(userMessage, ctx.state)
      const llmSchema = symptomExtractOutputSchema.omit({ userOriginalText: true })
      const result = await ctx.llm.structured({
        schema: llmSchema,
        schemaName: 'symptom_extraction',
        system: prompt.system,
        user: prompt.user,
        temperature: 0.1,
        trace: { traceLogger: ctx.traceLogger, caseId: ctx.caseId, node: 'symptom.extract' },
      })
      return { ...result, userOriginalText: userMessage }
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.traceLogger.log(ctx.caseId, 'llm_fallback', {
        reason: 'symptom.extract 使用词典规则降级抽取',
      })
      ctx.markFallback('symptom.extract: LLM 不可用，使用词典规则降级抽取')
      return heuristicExtract(userMessage)
    }
  },

  toStatePatch(output, state): Partial<CaseState> {
    const symptoms: Partial<SymptomState> = {
      chiefComplaint: output.chiefComplaint || state.symptoms.chiefComplaint || output.userOriginalText,
      onsetTime: output.onsetTime || undefined,
      duration: output.duration || undefined,
      location: output.location || undefined,
      severity: output.severity || undefined,
      frequency: output.frequency || undefined,
      painQuality: output.painQuality || undefined,
      onsetPattern: output.onsetPattern || undefined,
      triggers: output.triggers,
      relievingFactors: output.relievingFactors,
      associatedSymptoms: output.associatedSymptoms,
      negativeSymptoms: output.negativeSymptoms,
      progression: output.progression,
      userOriginalText: [output.userOriginalText],
    }

    const validAge =
      typeof output.age === 'number' && Number.isFinite(output.age) && output.age > 0 && output.age <= 120
        ? Math.round(output.age)
        : undefined

    const userProfile: Partial<UserProfile> = {
      age: validAge,
      sex: output.sex === 'unknown' ? undefined : output.sex,
      pregnancy: output.pregnancy ?? undefined,
      chronicDiseases: output.chronicDiseases.length > 0 ? output.chronicDiseases : undefined,
      currentMedications: output.currentMedications.length > 0 ? output.currentMedications : undefined,
    }

    return {
      symptoms: symptoms as SymptomState,
      userProfile: userProfile as UserProfile,
    }
  },

  toTrace(output) {
    return { output, reason: '症状抽取完成' }
  },
})

/** 词典 + 规则降级抽取 */
function heuristicExtract(userMessage: string): SymptomExtractOutput {
  const text = normalizeSymptomText(userMessage)

  const allSignals = Array.from(
    new Set(SYMPTOM_DOMAIN_CONFIGS.flatMap((config) => [...config.redFlagSignals, ...config.triggerTerms])),
  )
  const { confirmed, denied } = extractTermsByDictionary(text, allSignals)

  const ageMatch = text.match(/(\d{1,3})\s*岁/)
  const worsening = /越来越(重|疼|痛|严重)|不断加重|加重了/.test(text)
  const improving = /好(多了|转)|缓解了|轻多了/.test(text)

  return {
    chiefComplaint: userMessage.slice(0, 60),
    onsetTime: '',
    duration: extractDurationText(text) ?? '',
    location: '',
    severity: /剧烈|特别(疼|痛|严重)|受不了/.test(text) ? '重' : '',
    frequency: '',
    painQuality: /压榨|闷紧|压迫/.test(text) ? '压榨感' : /刺痛|针扎/.test(text) ? '刺痛' : '',
    onsetPattern: /突然|一下子/.test(text) ? '突然发生' : '',
    triggers: /熬夜|通宵/.test(text) ? ['熬夜'] : [],
    relievingFactors: improving ? ['休息后缓解'] : [],
    associatedSymptoms: confirmed,
    negativeSymptoms: denied,
    progression: worsening ? 'worsening' : improving ? 'improving' : 'unknown',
    age: ageMatch ? Number(ageMatch[1]) : null,
    sex: 'unknown',
    pregnancy: /怀孕|孕期|孕妇/.test(text) ? true : null,
    chronicDiseases: [],
    currentMedications: [],
    unclearFields: ['heuristic_extraction'],
    userOriginalText: userMessage,
  }
}
