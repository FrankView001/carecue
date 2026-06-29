// 主循环 AgentLoop：约束式事件循环（设计文档 2.1 / 2.2）。
// 不是状态机；每轮由 requiredAction 兜底硬约束、LLM 决策、Guard 复核、工具执行、写回。

import type { FinalReport, ToolCall } from '../schemas/index.ts'
import type { Llm } from './llm.ts'
import { MockLlm, createDeepSeekLlm } from './llm.ts'
import { Workspace } from './workspace.ts'
import { guard, guardReport } from './guard.ts'
import { noopTracer, type Tracer } from './trace.ts'
import { loadKnowledge, type Knowledge } from '../knowledge/loader.ts'
import { createM1ToolRegistry, ToolRegistry, type ToolContext, type ToolResult } from '../tools/index.ts'

const MAX_STEPS = 12

export type RiskLevel = 'R0' | 'R1' | 'R3'

interface ResponseBase {
  caseId: string
  riskLevel: RiskLevel
  rounds: number
  snapshot: ReturnType<Workspace['toSnapshot']>
}

export type ConsultResponse =
  | (ResponseBase & { type: 'followup'; question: string; target?: string })
  | (ResponseBase & { type: 'final_report'; report: FinalReport; rendered: string })
  | (ResponseBase & {
      type: 'emergency'
      content: string
      doctorSummary: string
      triggeredCombination: string[]
    })
  | (ResponseBase & { type: 'stage_report'; content: string; reason: string })

type ResponseTail =
  | { type: 'followup'; question: string; target?: string }
  | { type: 'final_report'; report: FinalReport; rendered: string }
  | { type: 'emergency'; content: string; doctorSummary: string; triggeredCombination: string[] }
  | { type: 'stage_report'; content: string; reason: string }

export interface ConsultInput {
  caseId: string
  userMessage: string
  age?: number
  sex?: 'male' | 'female'
}

function riskLevel(ws: Workspace): RiskLevel {
  if (ws.positiveHighRiskRedFlag()) return 'R3'
  if (ws.pendingRedFlags().length > 0) return 'R1'
  return 'R0'
}

/** 硬约束（设计文档 2.6 规则 1、5）：必须做但还没做的事，绕过 LLM 直接强制。 */
function requiredAction(ws: Workspace): ToolCall | undefined {
  if (ws.symptoms.length > 0 && !ws.redFlagsLoaded) {
    return { tool: 'lookup_red_flags', input: { symptoms: ws.symptoms } }
  }
  if (ws.positiveHighRiskRedFlag()) {
    return { tool: 'generate_report', input: {} }
  }
  return undefined
}

/** M1 naive 症状种子（extract_facts 在 M3 替换）：知识库词表命中即记入。 */
function seedSymptoms(ws: Workspace, message: string, knowledge: Knowledge): void {
  for (const term of knowledge.symptomVocabulary) {
    if (message.includes(term)) ws.addSymptom(term)
  }
}

/** 工具失败重试 1 次；再失败把错误作为结果返回（设计文档 2.7）。 */
async function executeWithRetry(
  run: () => ToolResult | Promise<ToolResult>,
  toolName: string,
): Promise<ToolResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await run()
    } catch (err) {
      if (attempt === 1) {
        return { ok: false, error: `${toolName} 执行异常：${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }
  return { ok: false, error: `${toolName} 执行异常` }
}

export interface ConsultEngineDeps {
  llm: Llm
  knowledge: Knowledge
  registry: ToolRegistry
  tracer?: Tracer
}

/** 一次咨询引擎：持有共享依赖与按 caseId 的 Workspace（内存存储；PG 持久化在 M3）。 */
export class ConsultEngine {
  private readonly llm: Llm
  private readonly knowledge: Knowledge
  private readonly registry: ToolRegistry
  private readonly tracer: Tracer
  private readonly store = new Map<string, Workspace>()

  constructor(deps: ConsultEngineDeps) {
    this.llm = deps.llm
    this.knowledge = deps.knowledge
    this.registry = deps.registry
    this.tracer = deps.tracer ?? noopTracer
  }

  getWorkspace(caseId: string): Workspace | undefined {
    return this.store.get(caseId)
  }

  async consult(input: ConsultInput): Promise<ConsultResponse> {
    const ws = this.store.get(input.caseId) ?? new Workspace(input.caseId)
    this.store.set(input.caseId, ws)
    if (input.age !== undefined) ws.age = input.age
    if (input.sex !== undefined) ws.sex = input.sex

    ws.rounds++
    seedSymptoms(ws, input.userMessage, this.knowledge)

    const ctx: ToolContext = {
      workspace: ws,
      knowledge: this.knowledge,
      lastUserMessage: input.userMessage,
    }

    let feedback: string | undefined

    for (let step = 0; step < MAX_STEPS; step++) {
      // 2/3. 硬约束优先，否则 LLM 决策。
      const forced = requiredAction(ws)
      let action: ToolCall = forced
        ? forced
        : await this.llm.decide({
            workspace: ws,
            lastUserMessage: input.userMessage,
            tools: this.registry.specs(),
            feedback,
          })
      feedback = undefined

      this.tracer.log({
        caseId: ws.caseId,
        kind: 'decision',
        name: action.tool,
        data: { forced: Boolean(forced), input: action.input },
      })

      // 4. Guard 复核。
      const verdict = guard(action, ws)
      if (!verdict.allow) {
        this.tracer.log({ caseId: ws.caseId, kind: 'guard', name: action.tool, data: { reason: verdict.reason } })
        if (verdict.suggest) {
          action = verdict.suggest
        } else {
          feedback = verdict.reason
          continue
        }
      }

      const tool = this.registry.get(action.tool)
      if (!tool) {
        feedback = `未知工具：${action.tool}`
        continue
      }

      const parsed = tool.inputSchema.safeParse(action.input)
      if (!parsed.success) {
        feedback = `工具 ${action.tool} 入参不合法：${parsed.error.message}`
        continue
      }

      // 5. 执行（失败重试 1 次）。
      const startedAt = Date.now()
      const result = await executeWithRetry(() => tool.run(parsed.data, ctx), action.tool)
      this.tracer.log({
        caseId: ws.caseId,
        kind: 'tool',
        name: action.tool,
        durationMs: Date.now() - startedAt,
        data: { ok: result.ok, summary: result.summary, error: result.error },
      })
      if (!result.ok) {
        feedback = `工具 ${action.tool} 失败：${result.error}`
        continue
      }

      // 7. 终止判断。
      if (result.interrupt) {
        return this.respond(ws, {
          type: 'followup',
          question: result.interrupt.question,
          target: result.interrupt.target,
        })
      }
      if (result.emergency) {
        return this.respond(ws, {
          type: 'emergency',
          content: result.emergency.content,
          doctorSummary: result.emergency.doctorSummary,
          triggeredCombination: result.emergency.triggeredCombination,
        })
      }
      if (result.report && result.rendered) {
        const rg = guardReport(result.rendered)
        if (!rg.allow) {
          feedback = rg.reason
          continue
        }
        return this.respond(ws, { type: 'final_report', report: result.report, rendered: result.rendered })
      }
      // 其余（lookup/update）已写回 Workspace，继续循环。
    }

    return this.respond(ws, {
      type: 'stage_report',
      content: '本轮信息已记录，但未能在限定步数内得出结论。请补充更多细节，或稍后再试。',
      reason: 'max_steps_reached',
    })
  }

  private respond(ws: Workspace, tail: ResponseTail): ConsultResponse {
    const snapshot = ws.toSnapshot()
    this.tracer.log({ caseId: ws.caseId, kind: 'snapshot', name: tail.type, data: snapshot })
    const base = {
      caseId: ws.caseId,
      riskLevel: riskLevel(ws),
      rounds: ws.rounds,
      snapshot,
    }
    // base 与 tail 都是良类型；联合体的展开赋值需经 unknown 中转（TS 已知限制）。
    return { ...base, ...tail } as unknown as ConsultResponse
  }
}

/** M1 工厂：Mock LLM + 本地知识库 + M1 工具集。 */
export function createM1Engine(llm: Llm = new MockLlm()): ConsultEngine {
  return new ConsultEngine({
    llm,
    knowledge: loadKnowledge(),
    registry: createM1ToolRegistry(),
  })
}

/**
 * M2 环境工厂：配置了 DeepSeek/OpenRouter Key 时用真实 LLM，否则回退 Mock。
 * 这样本地无 Key 也能跑通，线上配 Key 即接入真实模型（基础设施级回退见 llm.ts）。
 */
export function createConsultEngineFromEnv(tracer?: Tracer): ConsultEngine {
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim())
  const llm: Llm = hasKey ? createDeepSeekLlm({ tracer }) : new MockLlm()
  return new ConsultEngine({ llm, knowledge: loadKnowledge(), registry: createM1ToolRegistry(), tracer })
}
