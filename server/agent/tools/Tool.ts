// 统一 Tool 接口 — v3.0 设计文档 §16

import type { ZodType } from 'zod'
import type { CaseState } from '../case/CaseState.ts'
import type { TraceLogger, TracePayload } from '../logs/traceLogger.ts'
import type { AgentFailureCode } from '../failureRecovery.ts'
import type { LlmClient } from '../llm/llmClient.ts'
import type { SearchClient } from '../search/medicalSearchTool.ts'

export type ToolGuardLevel =
  | 'safe_read'
  | 'medical_search'
  | 'medical_reasoning'
  | 'medical_output'
  | 'emergency_output'

export type ToolGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string; failureCode: AgentFailureCode }

export interface ToolContext {
  caseId: string
  userId?: string
  state: CaseState
  abortSignal?: AbortSignal
  traceLogger: TraceLogger
  /** 依赖注入：LLM 与搜索客户端，便于测试替换 */
  llm: LlmClient
  search?: SearchClient
  /** 工具内部判断走了降级路径（如 LLM 不可用、解析失败）时调用，供 ToolExecutor 标注 status=fallback */
  markFallback: (reason: string) => void
}

export interface CareCueTool<I = unknown, O = unknown> {
  name: string
  description: string
  inputSchema: ZodType<I>
  outputSchema: ZodType<O>
  guardLevel: ToolGuardLevel
  parallelSafe: boolean
  timeoutMs: number
  maxCallsPerTurn: number
  guard(input: I, state: CaseState): ToolGuardResult
  call(input: I, ctx: ToolContext): Promise<O>
  toStatePatch(output: O, state: CaseState): Partial<CaseState>
  toTrace(output: O): TracePayload
}

/** 帮助函数：带默认值定义工具，减少样板 */
export function defineTool<I, O>(tool: {
  name: string
  description: string
  inputSchema: ZodType<I>
  outputSchema: ZodType<O>
  guardLevel: ToolGuardLevel
  parallelSafe?: boolean
  timeoutMs?: number
  maxCallsPerTurn?: number
  guard?: (input: I, state: CaseState) => ToolGuardResult
  call(input: I, ctx: ToolContext): Promise<O>
  toStatePatch?: (output: O, state: CaseState) => Partial<CaseState>
  toTrace?: (output: O) => TracePayload
}): CareCueTool<I, O> {
  return {
    parallelSafe: tool.parallelSafe ?? false,
    timeoutMs: tool.timeoutMs ?? 30000,
    maxCallsPerTurn: tool.maxCallsPerTurn ?? 3,
    guard: tool.guard ?? (() => ({ allowed: true })),
    toStatePatch: tool.toStatePatch ?? (() => ({})),
    toTrace: tool.toTrace ?? ((output) => ({ output })),
    ...tool,
  } as CareCueTool<I, O>
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
