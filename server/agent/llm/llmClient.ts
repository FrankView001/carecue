// LLM 客户端封装 — OpenRouter（DeepSeek），结构化输出 + 降级
// TECHNICAL.md §5：json_schema 不稳定时降级为 json_object + 本地 Zod 校验；
// 未配置 API Key 时抛出 LlmUnavailableError，由上层走规则降级。
// v3.1：调用方可传入 trace 钩子，记录完整请求/响应/解析结果/重试/失败原因，
// 模型请求成功但解析失败时 status 必须是 fallback/failed，不能继续显示 success。

import OpenAI from 'openai'
import type { ZodType } from 'zod'
import { zodResponseFormat } from 'openai/helpers/zod'
import type { TraceLogger, TraceStatus } from '../logs/traceLogger.ts'

export class LlmUnavailableError extends Error {
  constructor(message = 'LLM 未启用或未配置 API Key') {
    super(message)
    this.name = 'LlmUnavailableError'
  }
}

export class LlmOutputInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmOutputInvalidError'
  }
}

export type LlmTraceHook = {
  traceLogger: TraceLogger
  caseId: string
  node: string
}

export type LlmStructuredOptions<T> = {
  schema: ZodType<T>
  schemaName: string
  system: string
  user: string
  temperature?: number
  /** 可选：把这次调用的完整请求/响应写入 Trace（model_request/model_response） */
  trace?: LlmTraceHook
}

export interface LlmClient {
  readonly model: string
  available(): boolean
  structured<T>(options: LlmStructuredOptions<T>): Promise<T>
}

/** LLM 调用关键步骤日志，便于在后台定位"哪一步慢、花了多少 token"。AGENT_LLM_LOG=false 可关闭。 */
function logLlm(line: string) {
  if (process.env.AGENT_LLM_LOG !== 'false') {
    console.log(`[LLM] ${line}`)
  }
}

type Attempt<T> = {
  data?: T
  tokens?: number
  finishReason?: string
  httpStatus?: number
  responseRaw?: unknown
  responseParsed?: unknown
  durationMs: number
  mode: 'json_schema' | 'json_object'
  useModel: string
  error?: { name?: string; message: string; statusCode?: number; responseBody?: unknown }
}

export function createOpenRouterLlmClient(): LlmClient {
  const model = process.env.OPENROUTER_MODEL?.trim() || 'deepseek/deepseek-v4-pro'
  const fallbackModel = process.env.OPENROUTER_FALLBACK_MODEL?.trim()
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 20000)
  const baseURL = 'https://openrouter.ai/api/v1'

  // 一旦确认当前模型不支持 json_schema（response_format 报错），后续调用直接走 json_object，
  // 避免每次调用都先发一次注定失败的 json_schema 请求（这会让每步 LLM 付出双倍延迟）。
  let jsonSchemaDisabled = process.env.OPENROUTER_JSON_SCHEMA === 'false'

  const client = new OpenAI({
    baseURL,
    apiKey: process.env.OPENROUTER_API_KEY || 'dummy',
    timeout: timeoutMs,
    defaultHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:5173',
      'X-OpenRouter-Title': process.env.OPENROUTER_APP_TITLE || 'CareCue',
    },
  })

  function isAvailable(): boolean {
    return process.env.AI_ENABLED === 'true' && Boolean(process.env.OPENROUTER_API_KEY?.trim())
  }

  async function completeOnce<T>(
    options: LlmStructuredOptions<T>,
    useModel: string,
    mode: 'json_schema' | 'json_object',
  ): Promise<Attempt<T>> {
    const startedAt = Date.now()
    let completion: OpenAI.Chat.Completions.ChatCompletion
    try {
      completion = await client.chat.completions.create({
        model: useModel,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        temperature: options.temperature ?? 0.1,
        response_format:
          mode === 'json_schema'
            ? zodResponseFormat(options.schema, options.schemaName)
            : { type: 'json_object' },
      })
    } catch (error) {
      const err = error as { status?: number; message?: string; error?: unknown; name?: string }
      return {
        durationMs: Date.now() - startedAt,
        mode,
        useModel,
        error: {
          name: err.name,
          message: err.message ?? String(error),
          statusCode: err.status,
          responseBody: err.error,
        },
      }
    }

    const raw = completion.choices[0]?.message?.content
    const finishReason = completion.choices[0]?.finish_reason
    const tokens = completion.usage?.total_tokens ?? 0

    if (!raw) {
      return {
        durationMs: Date.now() - startedAt,
        mode,
        useModel,
        tokens,
        finishReason,
        responseRaw: completion,
        error: { name: 'LlmOutputInvalidError', message: 'LLM 未返回内容' },
      }
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch (jsonError) {
      return {
        durationMs: Date.now() - startedAt,
        mode,
        useModel,
        tokens,
        finishReason,
        responseRaw: raw,
        error: { name: 'JSONParseError', message: `LLM 返回内容不是合法 JSON: ${String(jsonError)}` },
      }
    }

    const parsed = options.schema.safeParse(parsedJson)
    if (!parsed.success) {
      return {
        durationMs: Date.now() - startedAt,
        mode,
        useModel,
        tokens,
        finishReason,
        responseRaw: raw,
        responseParsed: parsedJson,
        error: { name: 'SchemaValidationError', message: `LLM 输出不符合 schema: ${parsed.error.message}` },
      }
    }

    return {
      data: parsed.data,
      tokens,
      finishReason,
      durationMs: Date.now() - startedAt,
      mode,
      useModel,
      responseRaw: raw,
      responseParsed: parsed.data,
    }
  }

  function emitTrace(
    options: LlmStructuredOptions<unknown>,
    attempts: Attempt<unknown>[],
    status: TraceStatus,
    fallbackReason?: string,
  ) {
    const trace = options.trace
    if (!trace) return
    const last = attempts[attempts.length - 1]
    trace.traceLogger.logModelCall(trace.caseId, {
      node: trace.node,
      request: {
        provider: 'openrouter',
        model: last?.useModel ?? model,
        baseURL,
        temperature: options.temperature ?? 0.1,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        responseSchema: options.schemaName,
      },
      response: {
        responseRaw: last?.responseRaw,
        responseParsed: last?.responseParsed,
        usage: last?.tokens != null ? { totalTokens: last.tokens } : undefined,
        finishReason: last?.finishReason,
        retries: attempts.length - 1,
        timeoutMs,
        durationMs: attempts.reduce((sum, a) => sum + a.durationMs, 0),
      },
      status,
      fallbackReason,
      error: last?.error ? { name: last.error.name, message: last.error.message, statusCode: last.error.statusCode, responseBody: last.error.responseBody } : undefined,
    })
  }

  return {
    model,
    available: isAvailable,
    async structured<T>(options: LlmStructuredOptions<T>): Promise<T> {
      if (!isAvailable()) {
        throw new LlmUnavailableError()
      }

      const startedAt = Date.now()
      const useSchema = !jsonSchemaDisabled
      const attempts: Attempt<unknown>[] = []

      // json_schema -> json_object -> 备选模型，逐级降级
      const first = await completeOnce(options, model, useSchema ? 'json_schema' : 'json_object')
      attempts.push(first as Attempt<unknown>)
      if (!first.error) {
        logLlm(`${options.schemaName} ✓ ${model} ${useSchema ? 'schema' : 'json'} ${Date.now() - startedAt}ms ${first.tokens}tok`)
        emitTrace(options, attempts, 'success')
        return first.data as T
      }

      const formatError = isResponseFormatError(first.error.message)
      if (formatError && !jsonSchemaDisabled) {
        jsonSchemaDisabled = true
        logLlm('检测到模型不支持 json_schema，后续调用改用 json_object 模式')
      }

      if (first.error.name === 'SchemaValidationError' || first.error.name === 'JSONParseError' || formatError) {
        const second = await completeOnce(options, model, 'json_object')
        attempts.push(second as Attempt<unknown>)
        if (!second.error) {
          logLlm(`${options.schemaName} ✓ ${model} json(降级) ${Date.now() - startedAt}ms ${second.tokens}tok`)
          emitTrace(options, attempts, 'fallback', `首次请求${formatError ? '不支持 json_schema' : '解析/校验失败'}，降级为 json_object 模式后成功`)
          return second.data as T
        }

        if (fallbackModel) {
          const third = await completeOnce(options, fallbackModel, 'json_object')
          attempts.push(third as Attempt<unknown>)
          if (!third.error) {
            logLlm(`${options.schemaName} ✓ ${fallbackModel} json(备选模型) ${Date.now() - startedAt}ms ${third.tokens}tok`)
            emitTrace(options, attempts, 'fallback', '主模型多次失败，切换备选模型后成功')
            return third.data as T
          }
          logLlm(`${options.schemaName} ✗ ${Date.now() - startedAt}ms ${third.error.message}`)
          emitTrace(options, attempts, 'failed', '主模型与备选模型均失败')
          throw toThrowable(third.error)
        }
        logLlm(`${options.schemaName} ✗ ${Date.now() - startedAt}ms ${second.error.message}`)
        emitTrace(options, attempts, 'failed', '主模型 json_schema 与 json_object 均失败，且未配置备选模型')
        throw toThrowable(second.error)
      }

      if (fallbackModel) {
        const second = await completeOnce(options, fallbackModel, useSchema ? 'json_schema' : 'json_object')
        attempts.push(second as Attempt<unknown>)
        if (!second.error) {
          logLlm(`${options.schemaName} ✓ ${fallbackModel} ${useSchema ? 'schema' : 'json'}(备选模型) ${Date.now() - startedAt}ms ${second.tokens}tok`)
          emitTrace(options, attempts, 'fallback', `主模型请求异常（${first.error.message.slice(0, 120)}），切换备选模型后成功`)
          return second.data as T
        }
        logLlm(`${options.schemaName} ✗ ${Date.now() - startedAt}ms ${second.error.message}`)
        emitTrace(options, attempts, 'failed', '主模型与备选模型均请求失败')
        throw toThrowable(second.error)
      }

      logLlm(`${options.schemaName} ✗ ${Date.now() - startedAt}ms ${first.error.message}`)
      emitTrace(options, attempts, 'failed', undefined)
      throw toThrowable(first.error)
    },
  }
}

function toThrowable(error: { name?: string; message: string }): Error {
  if (error.name === 'SchemaValidationError' || error.name === 'JSONParseError' || error.name === 'LlmOutputInvalidError') {
    return new LlmOutputInvalidError(error.message)
  }
  return new Error(error.message)
}

function isResponseFormatError(message: string): boolean {
  return /response_format|json_schema|structured/i.test(message)
}
