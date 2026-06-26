// ToolExecutor — v3.0 设计文档 §18
// 职责：输入校验 -> guard -> 超时执行 -> 输出校验 -> statePatch -> trace
// v3.1：记录完整输入/输出/执行前状态/耗时，区分 success/fallback/failed/skipped。

import { randomUUID } from 'node:crypto'
import type { CaseState } from '../case/CaseState.ts'
import type { ToolResultMessage } from '../messages/AgentMessage.ts'
import type { TraceLogger } from '../logs/traceLogger.ts'
import type { AgentFailureCode } from '../failureRecovery.ts'
import type { ToolContext } from './Tool.ts'
import { withTimeout } from './Tool.ts'
import type { ToolRegistry } from './ToolRegistry.ts'

export type ToolExecutionResult<O> =
  | {
      status: 'success'
      output: O
      statePatch: Partial<CaseState>
      message: ToolResultMessage
    }
  | {
      status: 'error'
      output: undefined
      statePatch: Partial<CaseState>
      message: ToolResultMessage
    }

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private traceLogger: TraceLogger,
  ) {}

  async run<O = unknown>(toolName: string, input: unknown, ctx: ToolContext): Promise<ToolExecutionResult<O>> {
    const tool = this.registry.get(toolName)
    const stateBefore = ctx.state

    this.traceLogger.log(ctx.caseId, 'tool_use', { node: toolName, input: { toolName, input }, stateBefore, status: 'success' })

    const parsedInput = tool.inputSchema.safeParse(input)
    if (!parsedInput.success) {
      return this.fail({
        caseId: ctx.caseId,
        toolName,
        input,
        stateBefore,
        code: 'TOOL_INPUT_INVALID',
        message: parsedInput.error.message,
        recoverable: true,
      })
    }

    const guardResult = tool.guard(parsedInput.data, ctx.state)
    if (!guardResult.allowed) {
      this.traceLogger.log(ctx.caseId, 'tool_result', {
        node: toolName,
        input: { toolName, input: parsedInput.data },
        stateBefore,
        status: 'skipped',
        reason: guardResult.reason,
      })
      return this.fail({
        caseId: ctx.caseId,
        toolName,
        input: parsedInput.data,
        stateBefore,
        code: guardResult.failureCode,
        message: guardResult.reason,
        recoverable: true,
        skipped: true,
      })
    }

    let fallbackReason: string | undefined
    const ctxWithFallback: ToolContext = {
      ...ctx,
      markFallback: (reason: string) => {
        fallbackReason = reason
      },
    }

    const startedAt = Date.now()
    try {
      const output = await withTimeout(tool.call(parsedInput.data, ctxWithFallback), tool.timeoutMs)
      const durationMs = Date.now() - startedAt

      const parsedOutput = tool.outputSchema.safeParse(output)
      if (!parsedOutput.success) {
        return this.fail({
          caseId: ctx.caseId,
          toolName,
          input: parsedInput.data,
          stateBefore,
          code: 'TOOL_OUTPUT_INVALID',
          message: parsedOutput.error.message,
          recoverable: true,
          durationMs,
        })
      }

      const statePatch = tool.toStatePatch(parsedOutput.data, ctx.state)

      const message: ToolResultMessage = {
        toolUseId: randomUUID(),
        toolName,
        status: 'success',
        output: parsedOutput.data,
        statePatch,
        createdAt: new Date().toISOString(),
      }

      const trace = tool.toTrace(parsedOutput.data)
      this.traceLogger.logToolResult(ctx.caseId, {
        toolName,
        input: parsedInput.data,
        output: { ...trace, fullOutput: parsedOutput.data },
        statePatch,
        stateBefore,
        durationMs,
        status: fallbackReason ? 'fallback' : 'success',
        fallback: Boolean(fallbackReason),
        fallbackReason,
      })

      return {
        status: 'success',
        output: parsedOutput.data as O,
        statePatch,
        message,
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt
      return this.fail({
        caseId: ctx.caseId,
        toolName,
        input: parsedInput.data,
        stateBefore,
        code: 'TOOL_RUNTIME_ERROR',
        message: String(error),
        recoverable: true,
        durationMs,
        error,
      })
    }
  }

  private fail(input: {
    caseId: string
    toolName: string
    input?: unknown
    stateBefore?: unknown
    code: AgentFailureCode
    message: string
    recoverable: boolean
    durationMs?: number
    skipped?: boolean
    error?: unknown
  }): ToolExecutionResult<never> {
    const message: ToolResultMessage = {
      toolUseId: randomUUID(),
      toolName: input.toolName,
      status: 'error',
      error: {
        code: input.code,
        message: input.message,
        recoverable: input.recoverable,
      },
      createdAt: new Date().toISOString(),
    }

    this.traceLogger.log(input.caseId, 'tool_result', {
      node: input.toolName,
      input: { toolName: input.toolName, input: input.input },
      stateBefore: input.stateBefore,
      output: message.error,
      status: input.skipped ? 'skipped' : 'failed',
      durationMs: input.durationMs,
      reason: `tool failed: ${input.code}`,
      error: input.error instanceof Error
        ? { name: input.error.name, message: input.error.message, stack: input.error.stack }
        : { message: input.message },
    })

    return {
      status: 'error',
      output: undefined,
      statePatch: {},
      message,
    }
  }
}
