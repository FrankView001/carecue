// M1 共享 Zod schema 与领域类型。
// 工具入参 / 出参强约束（设计文档 2.7）：所有工具的 input 用这里的 schema parse。

import { z } from 'zod'

// ── 红旗 ──────────────────────────────────────────────────────────────────────
export const RedFlagStatusSchema = z.enum(['pending', 'ruled_out', 'positive'])
export type RedFlagStatus = z.infer<typeof RedFlagStatusSchema>

export const RedFlagSeveritySchema = z.enum(['high', 'medium', 'low'])
export type RedFlagSeverity = z.infer<typeof RedFlagSeveritySchema>

/** Workspace 中的红旗条目（运行态，带 status / evidence）。 */
export const RedFlagSchema = z.object({
  name: z.string(),
  status: RedFlagStatusSchema,
  severity: RedFlagSeveritySchema,
  ask: z.string(),
  positiveSignals: z.array(z.string()).default([]),
  evidence: z.string().optional(),
})
export type RedFlag = z.infer<typeof RedFlagSchema>

// ── 假设 ──────────────────────────────────────────────────────────────────────
export const HypothesisSchema = z.object({
  name: z.string(),
  weight: z.number().min(0).max(1),
  supportingEvidence: z.array(z.string()).default([]),
  againstEvidence: z.array(z.string()).default([]),
})
export type Hypothesis = z.infer<typeof HypothesisSchema>

// ── 工具入参 ───────────────────────────────────────────────────────────────────
export const LookupRedFlagsInput = z.object({
  symptoms: z.array(z.string()).min(1),
})

export const AskUserInput = z.object({
  question: z.string().min(1),
  /** 该问题指向的红旗名（用于回答后归位更新）。 */
  target: z.string().optional(),
})

export const UpdateRedFlagInput = z.object({
  name: z.string(),
  status: RedFlagStatusSchema,
  evidence: z.string().optional(),
})

export const GenerateReportInput = z.object({
  // 从 workspace 读，无需额外字段；保留占位以满足「所有工具入参用 Zod」。
}).strict()

export const ExtractFactsInput = z.object({
  text: z.string().min(1),
})

export const AddHypothesisInput = z.object({
  name: z.string().min(1),
  initialEvidence: z.string().optional(),
})

export const UpdateHypothesisInput = z.object({
  name: z.string().min(1),
  /** 权重增量，[-1, 1]；正=支持，负=反对。 */
  delta: z.number().min(-1).max(1),
  evidence: z.string().optional(),
})

export const SearchMedicalInput = z.object({
  query: z.string().min(1),
})

// ── 抽取结果（extract_facts 输出） ──────────────────────────────────────────────
export interface ExtractedFacts {
  symptoms: string[]
  age?: number
  sex?: 'male' | 'female'
  facts: Record<string, string>
}

// ── 工具动作（LLM 决策输出） ────────────────────────────────────────────────────
export type ToolName =
  | 'extract_facts'
  | 'lookup_red_flags'
  | 'ask_user'
  | 'update_red_flag'
  | 'add_hypothesis'
  | 'update_hypothesis'
  | 'search_medical'
  | 'generate_report'

export interface ToolCall {
  tool: ToolName
  input: unknown
}

// ── 最终报告 ───────────────────────────────────────────────────────────────────
export interface FinalReport {
  chiefComplaint: string
  checked: string[]          // 已排查并排除的红旗
  careAdvice: string[]       // 护理建议
  watchFor: string[]         // 需警惕、出现即就医的信号
  referral: { urgency: string; advice: string; department: string }
  disclaimer: string
}
