// 全链路 Trace 日志 — v3.1
// 目标：完整还原一次 Agent 请求从用户输入到最终响应的数据流转：
// 工具真实输入/输出、CaseState 前后变化、Agent 决策依据、模型请求/响应、检索请求/响应、
// fallback 的真实原因。不截断、不省略，调试模式下可还原全部数据。

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// 兼容旧版事件类型（仍在各模块中以 traceLogger.log(caseId, legacyType, payload) 调用）
// ---------------------------------------------------------------------------
export type LegacyTraceEventType =
  | 'user_input'
  | 'symptom_extracted'
  | 'symptom_domain_classified'
  | 'state_merged'
  | 'risk_probe'
  | 'risk_assessed'
  | 'agent_decision'
  | 'tool_use'
  | 'tool_result'
  | 'search_queries'
  | 'sources_accepted'
  | 'sources_rejected'
  | 'evidence_extracted'
  | 'hypotheses_updated'
  | 'care_plan_generated'
  | 'question_guard'
  | 'final_guard'
  | 'medication_boundary_guard'
  | 'emergency_guard'
  | 'failure_recovery'
  | 'final_output'
  | 'llm_fallback'

export type TraceEventType =
  | 'user_input'
  | 'tool_use'
  | 'tool_result'
  | 'agent_decision'
  | 'model_request'
  | 'model_response'
  | 'search_request'
  | 'search_response'
  | 'state_change'
  | 'failure_recovery'
  | 'final_output'

export type TraceStatus = 'success' | 'fallback' | 'failed' | 'skipped'

export interface TraceErrorInfo {
  name?: string
  message: string
  stack?: string
  statusCode?: number
  responseBody?: unknown
}

export interface TraceEvent {
  traceId: string
  sessionId?: string
  requestId?: string
  stepId: number
  timestamp: string
  elapsedMs: number
  durationMs?: number

  eventType: TraceEventType
  /** 兼容旧调用方传入的细分事件名，写入 metadata.legacyEventType，不丢信息 */
  legacyEventType?: LegacyTraceEventType

  node?: string
  status?: TraceStatus

  input?: unknown
  output?: unknown

  stateBefore?: unknown
  statePatch?: unknown
  stateAfter?: unknown
  stateDiff?: FieldDiff[]

  decision?: string
  decisionReason?: string
  decisionConditions?: unknown

  fallback?: boolean
  fallbackReason?: string

  error?: TraceErrorInfo

  metadata?: Record<string, unknown>
}

export interface FieldDiff {
  field: string
  before: unknown
  after: unknown
  overwritten: boolean
  droppedDueToEmpty: boolean
}

/** 旧调用方使用的简化 payload；新字段全部可选叠加 */
export type TracePayload = {
  input?: unknown
  output?: unknown
  reason?: string
  status?: TraceStatus
  node?: string
  stateBefore?: unknown
  statePatch?: unknown
  stateAfter?: unknown
  stateDiff?: FieldDiff[]
  decision?: string
  decisionReason?: string
  decisionConditions?: unknown
  fallback?: boolean
  fallbackReason?: string
  error?: TraceErrorInfo
  durationMs?: number
  metadata?: Record<string, unknown>
}

/** 关键事件始终输出到控制台摘要，便于排查耗时与 fallback */
const KEY_LEGACY_EVENTS = new Set<LegacyTraceEventType>([
  'user_input',
  'agent_decision',
  'tool_use',
  'tool_result',
  'search_queries',
  'sources_accepted',
  'sources_rejected',
  'evidence_extracted',
  'failure_recovery',
  'final_output',
])

const LEGACY_TO_NEW: Record<LegacyTraceEventType, TraceEventType> = {
  user_input: 'user_input',
  symptom_extracted: 'tool_result',
  symptom_domain_classified: 'tool_result',
  state_merged: 'state_change',
  risk_probe: 'tool_result',
  risk_assessed: 'tool_result',
  agent_decision: 'agent_decision',
  tool_use: 'tool_use',
  tool_result: 'tool_result',
  search_queries: 'search_request',
  sources_accepted: 'search_response',
  sources_rejected: 'search_response',
  evidence_extracted: 'search_response',
  hypotheses_updated: 'tool_result',
  care_plan_generated: 'tool_result',
  question_guard: 'tool_result',
  final_guard: 'tool_result',
  medication_boundary_guard: 'tool_result',
  emergency_guard: 'tool_result',
  failure_recovery: 'failure_recovery',
  final_output: 'final_output',
  llm_fallback: 'model_response',
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
export function traceEnabled(): boolean {
  return process.env.TRACE_ENABLED !== 'false'
}

export function traceLevel(): 'summary' | 'debug' {
  return process.env.TRACE_LEVEL === 'debug' ? 'debug' : 'summary'
}

export function traceLogDir(): string {
  return process.env.TRACE_LOG_DIR?.trim() || './logs/traces'
}

export function traceIncludeModelPayload(): boolean {
  return process.env.TRACE_INCLUDE_MODEL_PAYLOAD !== 'false'
}

export function traceIncludeState(): boolean {
  return process.env.TRACE_INCLUDE_STATE !== 'false'
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------
const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)$/i

const PHONE_PATTERN = /\b1[3-9]\d{9}\b/g
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
const ID_CARD_PATTERN = /\b\d{17}[\dXx]\b/g
const ADDRESS_PATTERN = /([一-龥]{2,}(省|市|区|县|街道|路|巷|号))[一-龥\d]{0,20}/g

/** 单遍替换：避免链式 .replace 时，前一步生成的掩码文案本身又被后续规则二次匹配（如掩码文案含“号”被地址规则再次命中） */
const COMBINED_PATTERN = new RegExp(
  [PHONE_PATTERN, ID_CARD_PATTERN, EMAIL_PATTERN, ADDRESS_PATTERN].map((re) => `(?:${re.source})`).join('|'),
  'g',
)

function maskString(value: string): string {
  return value.replace(COMBINED_PATTERN, (match) => {
    if (/^1[3-9]\d{9}$/.test(match)) return '[手机号已脱敏]'
    if (/^\d{17}[\dXx]$/.test(match)) return '[身份证号已脱敏]'
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(match)) return '[邮箱已脱敏]'
    return '[精确地址已脱敏]'
  })
}

/** 写日志前统一脱敏：移除敏感 header/凭证字段，掩码手机号/邮箱/身份证号/精确地址 */
export function sanitizeTraceData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value
  if (typeof value === 'string') return maskString(value)
  if (typeof value !== 'object') return value
  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceData(item, seen))
  }

  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = '[已脱敏]'
      continue
    }
    result[key] = sanitizeTraceData(val, seen)
  }
  return result
}

// ---------------------------------------------------------------------------
// TraceLogger
// ---------------------------------------------------------------------------
export class TraceLogger {
  private traces = new Map<string, TraceEvent[]>()
  private verbose: boolean
  private caseStartTimes = new Map<string, number>()
  private requestIds = new Map<string, string>()
  private sessionIds = new Map<string, string>()
  private dirReady = false

  constructor(options?: { verbose?: boolean }) {
    this.verbose = options?.verbose ?? (process.env.AGENT_TRACE_VERBOSE === 'true' || traceLevel() === 'debug')
  }

  /** 开启新的一轮请求（traceId）。同一 caseId 多轮对话各自拥有独立 traceId，sessionId=caseId 串联全程。 */
  beginRequest(caseId: string): string {
    const requestId = randomUUID().slice(0, 8)
    this.requestIds.set(caseId, requestId)
    this.sessionIds.set(caseId, caseId)
    return requestId
  }

  log(caseId: string, eventType: LegacyTraceEventType, payload: TracePayload = {}): TraceEvent {
    if (!traceEnabled()) {
      return this.buildEvent(caseId, eventType, payload, 0)
    }

    const events = this.traces.get(caseId) ?? []
    if (events.length === 0) {
      this.caseStartTimes.set(caseId, Date.now())
      if (!this.requestIds.has(caseId)) this.beginRequest(caseId)
    }

    const event = this.buildEvent(caseId, eventType, payload, events.length)
    events.push(event)
    this.traces.set(caseId, events)

    this.writeJsonl(event)

    if (this.verbose || KEY_LEGACY_EVENTS.has(eventType)) {
      this.printSummary(event, payload)
    }
    return event
  }

  private buildEvent(
    caseId: string,
    eventType: LegacyTraceEventType,
    payload: TracePayload,
    stepId: number,
  ): TraceEvent {
    const includeState = traceIncludeState()
    const includeModel = traceIncludeModelPayload()
    const isModelEvent = eventType === 'llm_fallback' || payload.metadata?.kind === 'model'
    const isSearchEvent = payload.metadata?.kind === 'search'

    const status: TraceStatus | undefined =
      payload.status ?? (payload.fallback ? 'fallback' : payload.error ? 'failed' : undefined)

    const event: TraceEvent = {
      traceId: this.requestIds.get(caseId) ?? caseId.slice(0, 8),
      sessionId: this.sessionIds.get(caseId) ?? caseId,
      requestId: this.requestIds.get(caseId),
      stepId,
      timestamp: new Date().toISOString(),
      elapsedMs: this.elapsedMs(caseId),
      durationMs: payload.durationMs,
      eventType: LEGACY_TO_NEW[eventType],
      legacyEventType: eventType,
      node: payload.node,
      status,
      input: sanitizeTraceData(payload.input),
      output: ((!includeModel && isModelEvent) || (!includeState && isSearchEvent)) ? '[omitted by TRACE config]' : sanitizeTraceData(payload.output),
      stateBefore: includeState ? sanitizeTraceData(payload.stateBefore) : undefined,
      statePatch: sanitizeTraceData(payload.statePatch),
      stateAfter: includeState ? sanitizeTraceData(payload.stateAfter) : undefined,
      stateDiff: payload.stateDiff,
      decision: payload.decision,
      decisionReason: payload.decisionReason ?? payload.reason,
      decisionConditions: sanitizeTraceData(payload.decisionConditions),
      fallback: payload.fallback,
      fallbackReason: payload.fallbackReason ?? (payload.fallback ? payload.reason : undefined),
      error: payload.error,
      metadata: { ...payload.metadata, legacyReason: payload.metadata?.legacyReason ?? payload.reason },
    }
    return event
  }

  private writeJsonl(event: TraceEvent) {
    if (traceLevel() !== 'debug' && !KEY_LEGACY_EVENTS.has(event.legacyEventType as LegacyTraceEventType)) {
      // summary 模式仍然落盘关键事件，便于事后排障；非关键事件跳过磁盘写入
      return
    }
    try {
      const dir = traceLogDir()
      if (!this.dirReady) {
        mkdirSync(dir, { recursive: true })
        this.dirReady = true
      }
      const file = join(dir, `${event.traceId}.jsonl`)
      appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (err) {
      console.error(`[Trace] 写入 JSONL 失败: ${String(err)}`)
    }
  }

  private printSummary(event: TraceEvent, payload: TracePayload) {
    const prefix = event.traceId
    const tag = `[Trace][${prefix}][#${event.stepId}][+${event.elapsedMs}ms]${event.durationMs != null ? `[${event.durationMs}ms]` : ''}`
    const statusText = event.status ? ` status=${event.status}` : ''

    switch (event.legacyEventType) {
      case 'tool_use': {
        const toolName = (payload.input as { toolName?: string })?.toolName ?? 'unknown'
        console.log(`${tag} tool_use ${toolName}`)
        break
      }
      case 'tool_result': {
        const toolName = (payload.input as { toolName?: string })?.toolName ?? payload.node ?? 'unknown'
        console.log(`${tag} tool_result ${toolName}${statusText}`, payload.fallbackReason ?? payload.reason ?? '')
        break
      }
      case 'agent_decision': {
        const action = (payload.output as { action?: string })?.action ?? payload.decision ?? '?'
        console.log(`${tag} agent_decision -> ${action}`, payload.decisionReason ?? payload.reason ?? '')
        break
      }
      case 'search_queries':
        console.log(`${tag} search_request`, summarizeOutput(payload.output))
        break
      case 'sources_accepted':
      case 'sources_rejected':
      case 'evidence_extracted':
        console.log(`${tag} ${event.legacyEventType}`, payload.reason ?? summarizeOutput(payload.output))
        break
      case 'failure_recovery':
        console.log(`${tag} failure_recovery`, payload.reason ?? '')
        break
      case 'final_output':
        console.log(`${tag} final_output`, payload.reason ?? '')
        break
      default:
        console.log(`${tag} ${event.legacyEventType}${statusText}`, payload.reason ?? '')
    }
  }

  private elapsedMs(caseId: string): number {
    const start = this.caseStartTimes.get(caseId) ?? Date.now()
    return Date.now() - start
  }

  logDecision(caseId: string, decision: unknown) {
    const d = decision as { action?: string; reason?: string }
    this.log(caseId, 'agent_decision', { output: decision, reason: d.reason, decision: d.action, decisionReason: d.reason })
  }

  logToolResult(caseId: string, payload: {
    toolName: string
    input?: unknown
    output?: unknown
    statePatch?: unknown
    stateBefore?: unknown
    stateAfter?: unknown
    durationMs?: number
    status?: TraceStatus
    fallback?: boolean
    fallbackReason?: string
    error?: TraceErrorInfo
  }) {
    const trace = payload.output as { reason?: unknown } | undefined
    const reason = typeof trace?.reason === 'string' ? trace.reason : undefined
    this.log(caseId, 'tool_result', {
      node: payload.toolName,
      input: payload.input,
      output: payload.output,
      statePatch: payload.statePatch,
      stateBefore: payload.stateBefore,
      stateAfter: payload.stateAfter,
      durationMs: payload.durationMs,
      status: payload.status ?? (payload.fallback ? 'fallback' : 'success'),
      fallback: payload.fallback,
      fallbackReason: payload.fallbackReason,
      error: payload.error,
      reason,
    })
  }

  /** 记录一次模型调用的完整请求/响应（model_request + model_response 一对事件） */
  logModelCall(caseId: string, payload: {
    node: string
    request: {
      provider: string
      model: string
      baseURL?: string
      temperature?: number
      maxTokens?: number
      messages: unknown
      responseSchema?: string
    }
    response?: {
      httpStatus?: number
      responseRaw?: unknown
      responseParsed?: unknown
      usage?: unknown
      finishReason?: string
      retries?: number
      timeoutMs?: number
      durationMs?: number
    }
    status: TraceStatus
    fallbackReason?: string
    error?: TraceErrorInfo
  }) {
    this.log(caseId, 'llm_fallback', {
      node: payload.node,
      status: payload.status,
      input: { kind: 'model_request', ...payload.request },
      output: { kind: 'model_response', ...payload.response },
      durationMs: payload.response?.durationMs,
      fallback: payload.status === 'fallback',
      fallbackReason: payload.fallbackReason,
      error: payload.error,
      metadata: { kind: 'model' },
    })
  }

  /** 记录一次检索调用的完整请求/响应 */
  logSearchCall(caseId: string, payload: {
    node: string
    query: string
    purpose: string
    provider: string
    requestParams?: unknown
    httpStatus?: number
    rawCount?: number
    filteredCount?: number
    filteredReasons?: unknown
    acceptedSources?: unknown
    retries?: number
    durationMs?: number
    status: TraceStatus
    failureReason?: string
    error?: TraceErrorInfo
  }) {
    this.log(caseId, 'search_queries', {
      node: payload.node,
      status: payload.status,
      input: { query: payload.query, purpose: payload.purpose, provider: payload.provider, requestParams: payload.requestParams },
      output: {
        httpStatus: payload.httpStatus,
        rawCount: payload.rawCount,
        filteredCount: payload.filteredCount,
        filteredReasons: payload.filteredReasons,
        acceptedSources: payload.acceptedSources,
        retries: payload.retries,
      },
      durationMs: payload.durationMs,
      fallback: payload.status === 'fallback',
      fallbackReason: payload.failureReason,
      error: payload.error,
    })
  }

  logStateChange(caseId: string, payload: {
    node: string
    stateBefore: unknown
    statePatch: unknown
    stateAfter: unknown
    stateDiff: FieldDiff[]
    reason: string
  }) {
    this.log(caseId, 'state_merged', {
      node: payload.node,
      status: 'success',
      stateBefore: payload.stateBefore,
      statePatch: payload.statePatch,
      stateAfter: payload.stateAfter,
      stateDiff: payload.stateDiff,
      reason: payload.reason,
      output: { changedFields: payload.stateDiff.map((d) => d.field) },
    })
  }

  getTrace(caseId: string): TraceEvent[] {
    return this.traces.get(caseId) ?? []
  }

  clear(caseId: string) {
    this.traces.delete(caseId)
    this.caseStartTimes.delete(caseId)
    this.requestIds.delete(caseId)
    this.sessionIds.delete(caseId)
  }
}

function summarizeOutput(output: unknown): string {
  if (output == null) return ''
  const text = typeof output === 'string' ? output : JSON.stringify(output)
  return text
}
