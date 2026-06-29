// 工具公共类型。工具是原子的、独立的、可单独测试的（设计文档 2.4）。
// 工具之间不互相调用；只由主循环编排。

import type { ZodType } from 'zod'
import type { FinalReport, ToolName } from '../schemas/index.ts'
import type { ToolSpec } from '../agent/llm.ts'
import type { Workspace } from '../agent/workspace.ts'
import type { Knowledge } from '../knowledge/loader.ts'
import type { Extractor } from '../agent/extractor.ts'
import type { SearchClient } from '../agent/search.ts'

export interface ToolContext {
  workspace: Workspace
  knowledge: Knowledge
  /** 本轮用户最新输入（部分工具需要，如把回答写成 evidence）。 */
  lastUserMessage: string
  /** extract_facts 用的抽取器。 */
  extractor: Extractor
  /** search_medical 用的联网检索客户端（未配置时为空，工具会优雅失败）。 */
  search?: SearchClient
}

export interface ToolResult {
  ok: boolean
  /** 写回 Workspace / Trace 的简短结果描述。 */
  summary?: string
  /** ask_user：中断循环，等用户回复。 */
  interrupt?: { question: string; target?: string }
  /** generate_report：正常报告。 */
  report?: FinalReport
  rendered?: string
  /** generate_report：急症提示。 */
  emergency?: { content: string; doctorSummary: string; triggeredCombination: string[] }
  /** 失败信息（作为工具结果反馈给 LLM，让它换方法）。 */
  error?: string
}

export interface Tool<I = unknown> {
  name: ToolName
  description: string
  inputSchema: ZodType<I>
  /** OpenAI 兼容的工具 schema，供 DeepSeek tool calling。 */
  spec: ToolSpec
  run(input: I, ctx: ToolContext): ToolResult | Promise<ToolResult>
}
