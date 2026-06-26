// AgentDecision 决策 — v3.0 设计文档 §8 / §31.3
// LLM 决策 + 代码硬性约束修正；LLM 不可用或输出非法时使用确定性策略。

import type { CaseState } from './case/CaseState.ts'
import { agentDecisionSchema, type AgentDecision } from './actionSchema.ts'
import { AGENT_LIMITS } from './agentLimits.ts'
import type { LlmClient } from './llm/llmClient.ts'
import { LlmUnavailableError } from './llm/llmClient.ts'
import { buildDecideActionPrompt } from './llm/prompts/decideAction.prompt.ts'
import type { TraceLogger } from './logs/traceLogger.ts'
import { userForcedSearchActive, webSearchEnabled } from './search/searchPolicy.ts'

export async function decideAction(input: {
  state: CaseState
  contextSummary: string
  llm: LlmClient
  traceLogger: TraceLogger
  /** 转移路径无歧义时跳过 LLM 决策（loop engineering：策略写在代码里，省一次 LLM 往返） */
  forceDeterministic?: boolean
}): Promise<AgentDecision> {
  const { state, llm, traceLogger } = input

  // 代码硬性前置：R3 直接 emergency_stop（不交给 LLM）
  if (state.risk.level === 'R3') {
    return forcedDecision('emergency_stop', '代码红旗规则已确认 R3，停止普通分析。')
  }

  // 确定性决策模式：AGENT_DECIDE_MODE=deterministic 全程跳过 LLM 决策（最快，但不会主动追问）；
  // forceDeterministic 用于单步快路径（如搜索完成后的下一步）
  if (input.forceDeterministic || process.env.AGENT_DECIDE_MODE === 'deterministic') {
    return enforceConstraints(deterministicDecision(state), state)
  }

  let decision: AgentDecision
  let usedFallback = false
  try {
    const prompt = buildDecideActionPrompt(state, input.contextSummary)
    decision = await llm.structured({
      schema: agentDecisionSchema,
      schemaName: 'agent_decision',
      system: prompt.system,
      user: prompt.user,
      temperature: 0.1,
      trace: { traceLogger, caseId: state.caseId, node: 'agent.decide_action' },
    })
  } catch (error) {
    usedFallback = true
    if (error instanceof LlmUnavailableError) {
      traceLogger.log(state.caseId, 'llm_fallback', { reason: 'decideAction 使用确定性策略' })
    } else {
      traceLogger.log(state.caseId, 'llm_fallback', {
        reason: `decideAction LLM 输出异常，使用确定性策略：${String(error)}`,
      })
    }
    decision = deterministicDecision(state)
  }

  const finalDecision = enforceConstraints(decision, state)
  traceLogger.log(state.caseId, 'agent_decision', {
    decision: finalDecision.action,
    decisionReason: finalDecision.reason,
    fallback: usedFallback || finalDecision.action !== decision.action,
    fallbackReason: usedFallback
      ? 'LLM 决策不可用或输出异常，已使用确定性策略'
      : finalDecision.action !== decision.action
        ? `LLM 提议的动作 "${decision.action}" 违反硬性约束，已由代码改写为 "${finalDecision.action}"`
        : undefined,
    decisionConditions: buildDecisionConditions(state, decision, finalDecision),
    output: finalDecision,
    status: 'success',
  })

  return finalDecision
}

function buildDecisionConditions(state: CaseState, llmDecision: AgentDecision, finalDecision: AgentDecision) {
  return {
    llmProposedAction: llmDecision.action,
    finalAction: finalDecision.action,
    overridden: llmDecision.action !== finalDecision.action,
    symptomDomain: state.symptomDomain.primaryDomain,
    riskLevel: state.risk.level,
    hasHypotheses: state.hypotheses.length > 0,
    hypothesesCount: state.hypotheses.length,
    evidenceCount: state.evidence.length,
    searchRoundsUsed: state.meta.searchRounds,
    maxSearchRounds: AGENT_LIMITS.maxSearchRounds,
    askedQuestionsCount: state.askedQuestions.length,
    maxAskedQuestionsTotal: AGENT_LIMITS.maxAskedQuestionsTotal,
    webSearchEnabled: webSearchEnabled(),
    userForcedSearchActive: userForcedSearchActive(state),
    unresolvedRedFlags: state.riskProbe.unresolvedRedFlags,
    missingRiskFields: state.missingInfo.map((m) => m.field),
    hasCarePlan: Boolean(state.carePlan),
  }
}

/** 代码侧约束修正：违反选择规则的决策被改写为合法决策（§8.3） */
export function enforceConstraints(decision: AgentDecision, state: CaseState): AgentDecision {
  // 联网检索被关闭 -> 改为基于现有信息分析/输出
  if (decision.action === 'search_medical' && !webSearchEnabled()) {
    return deterministicDecision(state, '联网检索已关闭，基于现有信息继续分析。')
  }

  // 搜索超限 -> 改为分析或最终回答（用户显式要求时放行一次，执行后标记即被清除）
  if (
    decision.action === 'search_medical' &&
    state.meta.searchRounds >= AGENT_LIMITS.maxSearchRounds &&
    !userForcedSearchActive(state)
  ) {
    return deterministicDecision(state, '搜索轮次已达上限，决策被修正。')
  }

  // 追问超限 -> 不再追问
  if (decision.action === 'ask_user' && state.askedQuestions.length >= AGENT_LIMITS.maxAskedQuestionsTotal) {
    return deterministicDecision(state, '追问总数已达上限，决策被修正。')
  }

  // 没有症状信息时不允许 analyze_case
  if (decision.action === 'analyze_case' && !state.symptoms.chiefComplaint) {
    return forcedDecision('ask_user', '没有症状信息，必须先向用户了解情况。')
  }

  // 已有足够证据时不再重复搜索（case-flow 显示连续 2 轮搜索占 ~137s）；
  // 用户显式要求联网时例外，按用户当前问题再检索一次
  if (decision.action === 'search_medical' && state.evidence.length > 0 && !userForcedSearchActive(state)) {
    return deterministicDecision(state, '已有联网证据，跳过重复搜索。')
  }

  // 没有疑似方向时不允许先搜索：应先 analyze_case（用户显式要求时按主诉直接检索）
  if (decision.action === 'search_medical' && state.hypotheses.length === 0 && !userForcedSearchActive(state)) {
    return forcedDecision('analyze_case', '尚无疑似方向，应先分析再按需检索。')
  }

  // 没有疑似方向或没有证据时不允许 generate_care_plan
  if (decision.action === 'generate_care_plan' && (state.hypotheses.length === 0 || state.evidence.length === 0)) {
    return deterministicDecision(state, '缺少疑似方向或证据，不能生成处理建议，决策被修正。')
  }

  // final_answer 前置条件：至少 1 个疑似方向
  if (decision.action === 'final_answer' && state.hypotheses.length === 0) {
    return deterministicDecision(state, '尚无疑似方向，不能 final_answer，决策被修正。')
  }

  return decision
}

/** 确定性决策策略（LLM 不可用 / 决策被修正时） */
export function deterministicDecision(state: CaseState, note?: string): AgentDecision {
  const prefix = note ? `${note} ` : ''

  // 0. 用户显式要求联网且本轮尚未检索 -> 优先按用户问题检索
  if (userForcedSearchActive(state)) {
    return forcedDecision('search_medical', `${prefix}用户显式要求联网核查，按当前问题检索权威资料。`)
  }

  // 1. 没有疑似方向 -> 先 analyze_case（避免无方向时盲目搜索，见 case-flow c9397b7b）
  if (state.hypotheses.length === 0) {
    return forcedDecision('analyze_case', `${prefix}尚无疑似方向，需要先分析病例。`)
  }

  // 2. 有疑似方向但缺证据且还能搜索 -> search_medical
  if (
    webSearchEnabled() &&
    state.evidence.length === 0 &&
    state.meta.searchRounds < AGENT_LIMITS.maxSearchRounds &&
    state.symptomDomain.primaryDomain !== 'unknown'
  ) {
    return forcedDecision('search_medical', `${prefix}已有疑似方向但缺医学证据，联网检索一次。`)
  }

  // 3. 完整支持域且没有 carePlan 且有证据 -> generate_care_plan
  if (
    state.symptomDomain.supportedDepth === 'full' &&
    !state.carePlan &&
    state.evidence.length > 0
  ) {
    return forcedDecision('generate_care_plan', `${prefix}已有疑似方向但没有处理建议。`)
  }

  // 4. 其他 -> final_answer
  return forcedDecision('final_answer', `${prefix}信息已足够形成阶段性判断，输出最终报告。`)
}

function forcedDecision(action: AgentDecision['action'], reason: string): AgentDecision {
  return {
    action,
    reason,
    decisionGoal: reason,
    confidence: 'medium',
    priority: 'high',
    shouldReturnToUser: action === 'ask_user' || action === 'final_answer' || action === 'emergency_stop',
  }
}
