// LLM 决策封装（设计文档 2.7）。
// - Llm 接口：给定 Workspace + 工具清单，返回下一步动作（ToolCall）。
// - MockLlm：确定性策略，等价于「一个有经验的家庭医生」会怎么编排工具（无 Key 时回退）。
// - DeepSeekLlm：DeepSeek 官方 API 主路径 + OpenRouter 回退（OpenAI 兼容 tool calling）。
//   基础设施级回退：DeepSeek 整体不可用时切到 OpenRouter，不在工具失败时回退（设计文档 2.7）。
//   底层 chat.completions 调用以 CompleteFn 注入，便于在不触网的情况下测试解析与回退。

import OpenAI from 'openai'
import type { ToolCall, ToolName } from '../schemas/index.ts'
import type { Workspace } from './workspace.ts'
import { noopTracer, type Tracer } from './trace.ts'

/** OpenAI 兼容的工具描述（供 DeepSeek tool calling）。 */
export interface ToolSpec {
  name: ToolName
  description: string
  parameters: Record<string, unknown>
}

export interface DecideInput {
  workspace: Workspace
  lastUserMessage: string
  tools: ToolSpec[]
  /** Guard / 工具失败的反馈，要求 LLM 换决策。 */
  feedback?: string
}

export interface Llm {
  readonly kind: string
  decide(input: DecideInput): Promise<ToolCall>
}

const NEGATIONS = ['没有', '没', '无', '不', '未', '别', '非']

/** 信号词出现且未被紧邻的否定词修饰才算命中（真实 LLM 天然理解否定，Mock 用轻量启发式）。 */
function signalPresent(message: string, signal: string): boolean {
  let from = 0
  for (;;) {
    const i = message.indexOf(signal, from)
    if (i < 0) return false
    const prefix = message.slice(Math.max(0, i - 2), i)
    if (!NEGATIONS.some((n) => prefix.includes(n))) return true
    from = i + signal.length
  }
}

function matchesPositive(message: string, signals: string[]): boolean {
  return signals.some((s) => signalPresent(message, s))
}

/**
 * Mock：以 Workspace 状态确定性地编排工具（对任意红旗知识库通用）。
 * 注意：lookup_red_flags 由主循环 requiredAction 强制，这里不需要主动发出。
 */
export class MockLlm implements Llm {
  readonly kind = 'mock'

  async decide({ workspace, lastUserMessage }: DecideInput): Promise<ToolCall> {
    // 1. 上一轮追问的红旗已被用户回答 → 归位更新。
    if (workspace.awaitingRedFlag) {
      const rf = workspace.redFlags.find((r) => r.name === workspace.awaitingRedFlag)
      if (rf) {
        const status = matchesPositive(lastUserMessage, rf.positiveSignals) ? 'positive' : 'ruled_out'
        return { tool: 'update_red_flag', input: { name: rf.name, status, evidence: lastUserMessage } }
      }
    }

    // 2. 还有未排查的红旗 → 追问下一个。
    const pending = workspace.pendingRedFlags()[0]
    if (pending) {
      return { tool: 'ask_user', input: { question: pending.ask, target: pending.name } }
    }

    // 3. 红旗排查完毕 → 出报告。
    return { tool: 'generate_report', input: {} }
  }
}

// ── DeepSeek 主路径 + OpenRouter 回退 ────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools: Array<{
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }>
  tool_choice: 'required'
  temperature: number
}

export interface ChatResponse {
  model?: string
  usage?: { total_tokens?: number }
  choices: Array<{
    message?: { tool_calls?: Array<{ function?: { name: string; arguments: string } }> | null }
  }>
}

/** 底层 chat.completions 调用，便于注入真实 OpenAI 客户端或测试用的假实现。 */
export type CompleteFn = (req: ChatRequest) => Promise<ChatResponse>

export interface ProviderConfig {
  name: 'deepseek' | 'openrouter'
  model: string
  complete: CompleteFn
}

const DECISION_SYSTEM = [
  '你是 CareCue 的诊断编排器，像有经验的家庭医生：先排查危险信号，再针对性追问，最后给非确诊护理建议。',
  '只能通过调用一个工具来推进，不要直接回答用户。每次只选最合适的一个工具。',
  '症状已知但红旗未加载时，先 lookup_red_flags；有未排查红旗时通过 ask_user 逐条排查，并据用户回答 update_red_flag；红旗排查完毕再 generate_report。',
  '不下确诊结论，不给具体药物剂量。',
].join('\n')

export interface DeepSeekLlmOptions {
  tracer?: Tracer
}

export class DeepSeekLlm implements Llm {
  readonly kind = 'deepseek'
  private readonly providers: ProviderConfig[]
  private readonly tracer: Tracer

  constructor(providers: ProviderConfig[], options: DeepSeekLlmOptions = {}) {
    if (providers.length === 0) throw new Error('DeepSeekLlm 需要至少一个 provider')
    this.providers = providers
    this.tracer = options.tracer ?? noopTracer
  }

  async decide({ workspace, lastUserMessage, tools, feedback }: DecideInput): Promise<ToolCall> {
    const userParts = [
      `当前工作区:\n${workspace.toSummary()}`,
      `用户最新输入: ${lastUserMessage || '（无）'}`,
    ]
    if (feedback) userParts.push(`上一步被拒绝/失败，请据此调整: ${feedback}`)

    const req: Omit<ChatRequest, 'model'> = {
      messages: [
        { role: 'system', content: DECISION_SYSTEM },
        { role: 'user', content: userParts.join('\n\n') },
      ],
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: 'required',
      temperature: 0.2,
    }

    let lastError: unknown
    for (const provider of this.providers) {
      const started = Date.now()
      try {
        const res = await provider.complete({ ...req, model: provider.model })
        const call = res.choices[0]?.message?.tool_calls?.[0]
        if (!call?.function) throw new Error('LLM 未返回 tool_call')
        const action: ToolCall = {
          tool: call.function.name as ToolName,
          input: safeJsonParse(call.function.arguments),
        }
        this.tracer.log({
          caseId: workspace.caseId,
          kind: 'llm',
          name: provider.name,
          durationMs: Date.now() - started,
          data: { model: provider.model, tokens: res.usage?.total_tokens, action, request: req.messages },
        })
        return action
      } catch (err) {
        lastError = err
        this.tracer.log({
          caseId: workspace.caseId,
          kind: 'error',
          name: `llm:${provider.name}`,
          durationMs: Date.now() - started,
          data: { model: provider.model, message: err instanceof Error ? err.message : String(err) },
        })
        // 基础设施级回退：当前 provider 整体失败 → 尝试下一个 provider。
      }
    }
    throw lastError instanceof Error ? lastError : new Error('所有 LLM provider 不可用')
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/** 把 OpenAI 客户端包成 CompleteFn（SDK 边界做一次类型收口）。 */
function openAiComplete(client: OpenAI): CompleteFn {
  return async (req) => {
    const res = await client.chat.completions.create(req as never)
    return res as unknown as ChatResponse
  }
}

/** 根据环境变量装配 DeepSeek（主）+ OpenRouter（回退）。 */
export function createDeepSeekLlm(options: DeepSeekLlmOptions = {}): DeepSeekLlm {
  const timeout = Number(process.env.AI_TIMEOUT_MS ?? 20000)
  const providers: ProviderConfig[] = []

  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (deepseekKey) {
    providers.push({
      name: 'deepseek',
      model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
      complete: openAiComplete(
        new OpenAI({
          baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
          apiKey: deepseekKey,
          timeout,
          maxRetries: 0,
        }),
      ),
    })
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim()
  if (openRouterKey) {
    providers.push({
      name: 'openrouter',
      model: process.env.OPENROUTER_MODEL?.trim() || 'deepseek/deepseek-chat',
      complete: openAiComplete(
        new OpenAI({
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: openRouterKey,
          timeout,
          maxRetries: 0,
        }),
      ),
    })
  }

  return new DeepSeekLlm(providers, options)
}
