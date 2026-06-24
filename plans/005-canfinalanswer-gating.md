# 005 - canFinalAnswer 门控与决策修正

> **优先级**：P0
> **影响**：高
> **工作量**：S
> **依赖**：[002](./002-differential-diagnosis-ruleout.md)
> **审计基线 commit**：`1628ad2`

---

## 1. 问题背景

用户反馈"痘痘"案例中，agent 在 must_rule_out 方向未排除、canFinalAnswer 未检查的情况下直接输出最终报告。

### 根因（已确认）

**根因 1：canFinalAnswer 未持久化到 CaseState**

`server/agent/analysis/caseAnalyzer.ts` 的 `sanitizeAnalysis` 函数（第 79-92 行）计算了 `canFinalAnswer`，但它只存在于 `CaseAnalyzeOutput` 中，未写入 `CaseState`。`decideAction.ts` 无法读取该字段。

**根因 2：decideAction 未检查 canFinalAnswer 和 ruleoutStatus**

`server/agent/decideAction.ts` 的 `enforceConstraints` 函数（第 51-100 行）检查了 `hypotheses.length === 0` 等条件，但未检查：
- `canFinalAnswer` 是否为 true
- `must_rule_out` 方向是否已处理（`ruleoutStatus` 非 `pending`）

**根因 3：decideAction prompt 未传递 canFinalAnswer**

`server/agent/llm/prompts/decideAction.prompt.ts` 的 `user` JSON（第 33-49 行）中 `hypotheses` 只包含 `name` 和 `likelihood`，未包含 `ruleoutStatus`，也未传递 `canFinalAnswer`。

---

## 2. 目标

1. `CaseState` 新增 `canFinalAnswer` 字段，由 `caseAnalyzeTool` 的 `toStatePatch` 持久化。
2. `decideAction.enforceConstraints` 在 `final_answer` 前检查 `canFinalAnswer` 和 `allRuleoutsResolved`。
3. `decideAction.prompt.ts` 传递 `canFinalAnswer` 和 `ruleoutStatus` 给 LLM。

---

## 3. 修改清单

### 3.1 文件：`server/agent/case/CaseState.ts`

**修改 1**：`CaseState` 新增 `canFinalAnswer` 和 `allRuleoutsResolved` 字段。

当前代码（第 134-150 行附近）：

```typescript
export interface CaseState {
  // ... 现有字段 ...
  hypotheses: Hypothesis[]
  carePlan?: CarePlan
  // ... 其他字段 ...
}
```

目标代码：

```typescript
export interface CaseState {
  // ... 现有字段 ...
  hypotheses: Hypothesis[]
  /** ★ 新增：病例分析是否允许最终回答（由 case.analyze 写入） */
  canFinalAnswer?: boolean
  /** ★ 新增：所有 must_rule_out 方向是否已处理（由 case.analyze 写入） */
  allRuleoutsResolved?: boolean
  carePlan?: CarePlan
  // ... 其他字段 ...
}
```

**修改 2**：`createInitialCaseState` 无需修改（新字段 optional，默认 undefined）。

### 3.2 文件：`server/agent/analysis/caseAnalyzer.ts`

**修改 3**：`toStatePatch` 持久化 `canFinalAnswer` 和 `allRuleoutsResolved`。

当前代码（第 56-62 行）：

```typescript
toStatePatch(output): Partial<CaseState> {
  return {
    hypotheses: output.hypotheses as Hypothesis[],
    missingInfo: output.missingInfo.map((m) => ({
      ...m,
      relatedHypothesis: m.relatedHypothesis ?? undefined,
      relatedRiskRule: m.relatedRiskRule ?? undefined,
    })) as MissingInfo[],
  }
},
```

目标代码：

```typescript
toStatePatch(output): Partial<CaseState> {
  return {
    hypotheses: output.hypotheses as Hypothesis[],
    missingInfo: output.missingInfo.map((m) => ({
      ...m,
      relatedHypothesis: m.relatedHypothesis ?? undefined,
      relatedRiskRule: m.relatedRiskRule ?? undefined,
    })) as MissingInfo[],
    canFinalAnswer: output.canFinalAnswer,
    allRuleoutsResolved: output.allRuleoutsResolved,
  }
},
```

> **注意**：计划 002 的 `sanitizeAnalysis` 已计算 `allRuleoutsResolved`，本计划只需确保 `toStatePatch` 传递它。如果 002 未执行，`allRuleoutsResolved` 会是 undefined，门控检查会跳过（向后兼容）。

### 3.3 文件：`server/agent/decideAction.ts`

**修改 4**：`enforceConstraints` 新增 `final_answer` 门控。

当前代码（第 89-93 行）：

```typescript
// final_answer 前置条件：至少 1 个疑似方向
if (decision.action === 'final_answer' && state.hypotheses.length === 0) {
  return deterministicDecision(state, '尚无疑似方向，不能 final_answer，决策被修正。')
}

return decision
```

目标代码：

```typescript
// final_answer 前置条件：至少 1 个疑似方向
if (decision.action === 'final_answer' && state.hypotheses.length === 0) {
  return deterministicDecision(state, '尚无疑似方向，不能 final_answer，决策被修正。')
}

// ★ 新增：canFinalAnswer 门控（case.analyze 明确表示不能最终回答时，不允许 final_answer）
if (decision.action === 'final_answer' && state.canFinalAnswer === false) {
  // canFinalAnswer 为 false 时，根据情况选择 ask_user 或 analyze_case
  if (state.meta.followupRounds < 3) {
    return forcedDecision('ask_user', '病例分析判断 canFinalAnswer=false，需要补充信息。')
  }
  return forcedDecision('analyze_case', '病例分析判断 canFinalAnswer=false，需要重新分析。')
}

// ★ 新增：must_rule_out 未处理时不允许 final_answer
if (
  decision.action === 'final_answer' &&
  state.allRuleoutsResolved === false
) {
  // 存在未处理的 must_rule_out 方向，应先 ruleout
  return forcedDecision('analyze_case', '存在未排除的 must_rule_out 方向，需要先完成排除分析。')
}

return decision
```

**修改 5**：`deterministicDecision` 中 `final_answer` 前置检查。

当前代码（第 113-130 行）：

```typescript
export function deterministicDecision(state: CaseState, note?: string): AgentDecision {
  const prefix = note ? `${note} ` : ''

  if (userForcedSearchActive(state)) {
    return forcedDecision('search_medical', `${prefix}用户显式要求联网核查，按当前问题检索权威资料。`)
  }

  if (state.hypotheses.length === 0) {
    return forcedDecision('analyze_case', `${prefix}尚无疑似方向，需要先分析病例。`)
  }

  // ...
  return forcedDecision('final_answer', `${prefix}信息已足够形成阶段性判断，输出最终报告。`)
}
```

目标代码（在 `final_answer` 前增加检查）：

```typescript
export function deterministicDecision(state: CaseState, note?: string): AgentDecision {
  const prefix = note ? `${note} ` : ''

  if (userForcedSearchActive(state)) {
    return forcedDecision('search_medical', `${prefix}用户显式要求联网核查，按当前问题检索权威资料。`)
  }

  if (state.hypotheses.length === 0) {
    return forcedDecision('analyze_case', `${prefix}尚无疑似方向，需要先分析病例。`)
  }

  // ★ 新增：canFinalAnswer 为 false 时不走 final_answer
  if (state.canFinalAnswer === false) {
    if (state.meta.followupRounds < 3) {
      return forcedDecision('ask_user', `${prefix}病例分析判断 canFinalAnswer=false，需要补充信息。`)
    }
    return forcedDecision('analyze_case', `${prefix}病例分析判断 canFinalAnswer=false，需要重新分析。`)
  }

  // ★ 新增：allRuleoutsResolved 为 false 时不走 final_answer
  if (state.allRuleoutsResolved === false) {
    return forcedDecision('analyze_case', `${prefix}存在未排除的 must_rule_out 方向，需要先完成排除分析。`)
  }

  // ... 其余不变 ...
  return forcedDecision('final_answer', `${prefix}信息已足够形成阶段性判断，输出最终报告。`)
}
```

### 3.4 文件：`server/agent/llm/prompts/decideAction.prompt.ts`

**修改 6**：`user` JSON 传递 `canFinalAnswer` / `allRuleoutsResolved` / `ruleoutStatus`。

当前代码（第 33-49 行）：

```typescript
const user = JSON.stringify({
  caseSummary: {
    riskLevel: state.risk.level,
    riskReason: state.risk.reason,
    primaryDomain: state.symptomDomain.primaryDomain,
    supportedDepth: state.symptomDomain.supportedDepth,
    symptoms: state.symptoms,
    riskProbe: {
      status: state.riskProbe.probeStatus,
      unresolvedRedFlags: state.riskProbe.unresolvedRedFlags,
      canProceedToAnalysis: state.riskProbe.canProceedToAnalysis,
    },
    hypothesesCount: state.hypotheses.length,
    hypotheses: state.hypotheses.map((h) => ({ name: h.name, likelihood: h.likelihood })),
    evidenceCount: state.evidence.length,
    hasCarePlan: Boolean(state.carePlan),
    missingInfo: state.missingInfo,
    meta: state.meta,
    recentDecisions: state.decisionHistory.slice(-3).map((d) => d.action),
  },
  contextSummary,
})
```

目标代码：

```typescript
const user = JSON.stringify({
  caseSummary: {
    riskLevel: state.risk.level,
    riskReason: state.risk.reason,
    primaryDomain: state.symptomDomain.primaryDomain,
    supportedDepth: state.symptomDomain.supportedDepth,
    symptoms: state.symptoms,
    riskProbe: {
      status: state.riskProbe.probeStatus,
      unresolvedRedFlags: state.riskProbe.unresolvedRedFlags,
      canProceedToAnalysis: state.riskProbe.canProceedToAnalysis,
    },
    hypothesesCount: state.hypotheses.length,
    hypotheses: state.hypotheses.map((h) => ({
      name: h.name,
      likelihood: h.likelihood,
      ruleoutStatus: h.ruleoutStatus,  // ★ 新增
    })),
    evidenceCount: state.evidence.length,
    hasCarePlan: Boolean(state.carePlan),
    missingInfo: state.missingInfo,
    meta: state.meta,
    recentDecisions: state.decisionHistory.slice(-3).map((d) => d.action),
    // ★ 新增
    canFinalAnswer: state.canFinalAnswer,
    allRuleoutsResolved: state.allRuleoutsResolved,
  },
  contextSummary,
})
```

**修改 7**：`system` 新增决策规则。

当前代码（第 5-21 行）：

```typescript
const system = `你是问康 CareCue 的 Agent 决策器。

你只能输出以下 action 之一：
search_medical / analyze_case / generate_care_plan / ask_user / final_answer / emergency_stop

决策规则：
1. 不能直接回答用户，只输出决策 JSON，且必须说明 decisionGoal。
2. 如果尚无疑似方向，优先 analyze_case；形成疑似方向后若缺医学证据，再 search_medical（每轮最多 ${AGENT_LIMITS.maxQueriesPerRound} 个检索词，不允许照抄用户原话）。
3. 如果缺失的用户信息会明显影响风险判断或方向排序，选择 ask_user。
4. 如果已有证据但没有形成疑似方向，选择 analyze_case。
5. 如果已有疑似方向但没有处理建议，选择 generate_care_plan。
6. 如果能形成安全的阶段判断（至少 1 个疑似方向 + 支持/反对依据 + 处理建议 + 用药边界 + 何时就医），选择 final_answer。
7. 如果命中明确急症，选择 emergency_stop。
8. 当前搜索轮次已达 ${state.meta.searchRounds}/${AGENT_LIMITS.maxSearchRounds}，达到上限后禁止 search_medical。
9. 累计追问 ${state.askedQuestions.length}/${AGENT_LIMITS.maxAskedQuestionsTotal}，达到上限后禁止 ask_user。

只返回符合 JSON Schema 的 JSON。`
```

目标代码：

```typescript
const system = `你是问康 CareCue 的 Agent 决策器。

你只能输出以下 action 之一：
search_medical / analyze_case / generate_care_plan / ask_user / final_answer / emergency_stop

决策规则：
1. 不能直接回答用户，只输出决策 JSON，且必须说明 decisionGoal。
2. 如果尚无疑似方向，优先 analyze_case；形成疑似方向后若缺医学证据，再 search_medical（每轮最多 ${AGENT_LIMITS.maxQueriesPerRound} 个检索词，不允许照抄用户原话）。
3. 如果缺失的用户信息会明显影响风险判断或方向排序，选择 ask_user。
4. 如果已有证据但没有形成疑似方向，选择 analyze_case。
5. 如果已有疑似方向但没有处理建议，选择 generate_care_plan。
6. 如果能形成安全的阶段判断（至少 1 个疑似方向 + 支持/反对依据 + 处理建议 + 用药边界 + 何时就医），选择 final_answer。
7. 如果命中明确急症，选择 emergency_stop。
8. 当前搜索轮次已达 ${state.meta.searchRounds}/${AGENT_LIMITS.maxSearchRounds}，达到上限后禁止 search_medical。
9. 累计追问 ${state.askedQuestions.length}/${AGENT_LIMITS.maxAskedQuestionsTotal}，达到上限后禁止 ask_user。
10. **如果 canFinalAnswer 为 false，禁止选择 final_answer**，应根据 shouldAskUser / shouldSearchMore 选择 ask_user 或 search_medical。
11. **如果 allRuleoutsResolved 为 false（存在未排除的 must_rule_out 方向），禁止选择 final_answer**，应选择 analyze_case 完成排除分析。

只返回符合 JSON Schema 的 JSON。`
```

---

## 4. 实施步骤

### 步骤 1：CaseState 新增字段

1. `Edit` `server/agent/case/CaseState.ts`，`CaseState` 新增 `canFinalAnswer` 和 `allRuleoutsResolved` 字段。
2. 验证：`npm run typecheck:api` 通过。

### 步骤 2：caseAnalyzer 持久化字段

1. `Edit` `server/agent/analysis/caseAnalyzer.ts`，`toStatePatch` 新增 `canFinalAnswer` 和 `allRuleoutsResolved`。
2. 验证：`npm run typecheck:api` 通过。

### 步骤 3：decideAction 门控

1. `Edit` `server/agent/decideAction.ts`，`enforceConstraints` 新增 `canFinalAnswer` 和 `allRuleoutsResolved` 门控。
2. `Edit` `deterministicDecision`，新增同样的前置检查。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 4：decideAction prompt 更新

1. `Edit` `server/agent/llm/prompts/decideAction.prompt.ts`，`system` 新增第 10、11 条规则。
2. `Edit` `user` JSON，传递 `canFinalAnswer` / `allRuleoutsResolved` / `ruleoutStatus`。
3. 验证：`npm run typecheck:api` + `npm run test:agent` 通过。

### 步骤 5：新增测试

1. `Edit` `server/agent/agent.v3.test.ts`，新增门控测试。
2. 验证：`npm run test:agent` 通过。

---

## 5. 验证命令

```powershell
npm run typecheck:api
npm run lint
npm run test:agent
```

---

## 6. 测试计划

### 6.1 新增测试用例

```typescript
// 测试 1：canFinalAnswer=false 时 final_answer 被修正
test('门控：canFinalAnswer=false 时 final_answer 被修正为 ask_user', () => {
  const state = createInitialCaseState('test-gating-1')
  state.hypotheses = [{ name: '测试方向', likelihood: 'possible', /* ... */ } as Hypothesis]
  state.canFinalAnswer = false
  state.meta.followupRounds = 1

  const decision: AgentDecision = {
    action: 'final_answer',
    reason: '测试',
    decisionGoal: '测试',
    confidence: 'medium',
    priority: 'high',
    shouldReturnToUser: true,
  }

  const result = enforceConstraints(decision, state)
  expect(result.action).toBe('ask_user')
})

// 测试 2：allRuleoutsResolved=false 时 final_answer 被修正
test('门控：allRuleoutsResolved=false 时 final_answer 被修正为 analyze_case', () => {
  const state = createInitialCaseState('test-gating-2')
  state.hypotheses = [{ name: '测试方向', likelihood: 'must_rule_out', /* ... */ } as Hypothesis]
  state.canFinalAnswer = true
  state.allRuleoutsResolved = false

  const decision: AgentDecision = {
    action: 'final_answer',
    reason: '测试',
    decisionGoal: '测试',
    confidence: 'medium',
    priority: 'high',
    shouldReturnToUser: true,
  }

  const result = enforceConstraints(decision, state)
  expect(result.action).toBe('analyze_case')
})

// 测试 3：canFinalAnswer=true 且 allRuleoutsResolved=true 时允许 final_answer
test('门控：条件满足时允许 final_answer', () => {
  const state = createInitialCaseState('test-gating-3')
  state.hypotheses = [{ name: '测试方向', likelihood: 'possible', /* ... */ } as Hypothesis]
  state.canFinalAnswer = true
  state.allRuleoutsResolved = true

  const decision: AgentDecision = {
    action: 'final_answer',
    reason: '测试',
    decisionGoal: '测试',
    confidence: 'medium',
    priority: 'high',
    shouldReturnToUser: true,
  }

  const result = enforceConstraints(decision, state)
  expect(result.action).toBe('final_answer')
})

// 测试 4：canFinalAnswer 未设置（undefined）时不拦截（向后兼容）
test('门控：canFinalAnswer=undefined 时不拦截', () => {
  const state = createInitialCaseState('test-gating-4')
  state.hypotheses = [{ name: '测试方向', likelihood: 'possible', /* ... */ } as Hypothesis]
  // canFinalAnswer 未设置

  const decision: AgentDecision = {
    action: 'final_answer',
    reason: '测试',
    decisionGoal: '测试',
    confidence: 'medium',
    priority: 'high',
    shouldReturnToUser: true,
  }

  const result = enforceConstraints(decision, state)
  expect(result.action).toBe('final_answer')
})
```

---

## 7. 范围边界

### 在范围内

- `server/agent/case/CaseState.ts`（新增字段）
- `server/agent/analysis/caseAnalyzer.ts`（`toStatePatch`）
- `server/agent/decideAction.ts`（`enforceConstraints` + `deterministicDecision`）
- `server/agent/llm/prompts/decideAction.prompt.ts`
- `server/agent/agent.v3.test.ts`

### 不在范围内

- `caseAnalyzer.ts` 的两阶段重构（计划 002）
- `agentLoop.ts` 的 R0/R1 强制追问（计划 004）
- `finalAnswerGuard.ts`（已有安全守卫，不修改）

---

## 8. 维护说明

- `canFinalAnswer` 和 `allRuleoutsResolved` 是 optional 字段，undefined 时不拦截（向后兼容）。
- 门控逻辑在 `enforceConstraints` 和 `deterministicDecision` 两处实现，确保 LLM 决策和确定性决策都受控。
- 如果 `case.analyze` 未执行（如 LLM 不可用降级），`canFinalAnswer` 为 undefined，门控不拦截，由 `finalAnswerGuard` 兜底。
- `decideAction.prompt.ts` 的第 10、11 条规则是软约束（LLM 可能不遵守），`enforceConstraints` 是硬约束（代码强制修正），两者配合确保安全。

---

## 9. 回滚策略

如果门控导致 `final_answer` 永远无法触发（死循环）：

1. `git checkout -- server/agent/decideAction.ts`
2. `CaseState.ts` 的 `canFinalAnswer` / `allRuleoutsResolved` 字段可保留（optional，不影响现有流程）。
3. `caseAnalyzer.ts` 的 `toStatePatch` 改动可保留（写入字段不影响现有消费方）。
4. 回滚后运行 `npm run test:agent` 确认基线恢复。
5. 如需调整门控严格程度，修改 `enforceConstraints` 中的条件（如 `canFinalAnswer === false` 改为 `canFinalAnswer === false && state.evidence.length > 0`）。
