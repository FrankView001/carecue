# 004 - R0/R1 关键信息缺失强制追问

> **优先级**：P0
> **影响**：高
> **工作量**：M
> **依赖**：[001](./001-multi-domain-symptom-analysis.md)
> **审计基线 commit**：`1628ad2`

---

## 1. 问题背景

用户反馈"痘痘+身体紧绷"案例中，agent 在信息不足（缺病程、部位等）的情况下直接进入分析并输出"痤疮"结论，缺乏医学诊断中"先排除后确认"的专业流程。

### 根因（已确认）

**根因 1：agentLoop 仅 R2 强制追问**

`server/agent/agentLoop.ts` 第 145-170 行，仅当 `state.risk.level === 'R2' && state.riskProbe.unresolvedRedFlags.length > 0` 时强制风险核查追问。R0/R1 即使 `requiredCoreFields` 缺失，也会直接进入决策主循环，可能被 `decideAction` 选为 `analyze_case` → `final_answer`。

```typescript
// agentLoop.ts 第 145-170 行（R2 强制追问分支）
if (state.risk.level === 'R2' && state.riskProbe.unresolvedRedFlags.length > 0 && state.riskProbe.probeStatus === 'in_progress') {
  const questionsResult = await runTool<FollowupOutput>('question.generate_risk_probe', {})
  // ...
}
```

**根因 2：requiredCoreFields 缺失无强制检查**

`server/agent/symptoms/symptomDomainConfig.ts` 中每个域定义了 `requiredCoreFields`（如皮肤域需要 `duration` / `location` / `associatedSymptoms`），但 `agentLoop.ts` 和 `decideAction.ts` 都未检查这些字段是否已填充。

**根因 3：decideAction 未使用 canFinalAnswer**

`server/agent/decideAction.ts` 的 `enforceConstraints` 函数未检查 `state` 中是否有 `canFinalAnswer` 标记（实际上 `canFinalAnswer` 在 `CaseAnalyzeOutput` 中，未持久化到 `CaseState`），允许信息不足时直接 `final_answer`。

---

## 2. 目标

1. `agentLoop.ts` 在阶段 4（红旗评估）后、阶段 5（决策主循环）前，新增 R0/R1 关键信息缺失检查分支。
2. 当 R0/R1 且 `requiredCoreFields` 缺失且 `followupRounds === 0` 时，强制 `ask_user` 一次。
3. 强制追问只触发一次（用 `meta.followupRounds` 判断），避免循环。
4. 复用现有 `followupQuestionTool` 生成追问，不新增工具。

---

## 3. 修改清单

### 3.1 文件：`server/agent/case/CaseState.ts`

**修改 1**：`CaseMeta` 新增 `mandatoryFollowupUsed` 字段。

当前代码（第 119-129 行）：

```typescript
export interface CaseMeta {
  createdAt: string
  updatedAt: string
  lastUserMessageAt: string
  searchRounds: number
  followupRounds: number
  agentSteps: number
  language: 'zh' | 'en' | 'mixed'
  userRequestedSearch: boolean
}
```

目标代码：

```typescript
export interface CaseMeta {
  createdAt: string
  updatedAt: string
  lastUserMessageAt: string
  searchRounds: number
  followupRounds: number
  agentSteps: number
  language: 'zh' | 'en' | 'mixed'
  userRequestedSearch: boolean
  /** R0/R1 强制追问是否已使用（避免循环） */
  mandatoryFollowupUsed: boolean
}
```

**修改 2**：`createInitialCaseState` 初始化新字段。

当前代码（第 215-230 行）：

```typescript
meta: {
  createdAt: now,
  updatedAt: now,
  lastUserMessageAt: now,
  searchRounds: 0,
  followupRounds: 0,
  agentSteps: 0,
  language: 'zh',
  userRequestedSearch: false,
},
```

目标代码：

```typescript
meta: {
  createdAt: now,
  updatedAt: now,
  lastUserMessageAt: now,
  searchRounds: 0,
  followupRounds: 0,
  agentSteps: 0,
  language: 'zh',
  userRequestedSearch: false,
  mandatoryFollowupUsed: false,
},
```

### 3.2 文件：`server/agent/symptoms/symptomDomainConfig.ts`

**修改 3**：新增辅助函数 `getRequiredCoreFieldsForDomains`。

在文件末尾新增：

```typescript
/**
 * 获取多个域的 requiredCoreFields 并集（去重）。
 * 用于 R0/R1 强制追问时判断哪些核心字段缺失。
 */
export function getRequiredCoreFieldsForDomains(domains: SymptomDomain[]): string[] {
  const fieldSet = new Set<string>()
  for (const domain of domains) {
    const config = getDomainConfig(domain)
    if (config) {
      for (const field of config.requiredCoreFields) {
        fieldSet.add(field)
      }
    }
  }
  return Array.from(fieldSet)
}
```

### 3.3 文件：`server/agent/case/stateFields.ts`

**修改 4**：新增辅助函数 `getMissingCoreFields`。

> **执行者需先 Read 该文件**，理解现有 `buildKnownFacts` 等函数的实现模式。

在文件中新增：

```typescript
import type { CaseState } from './CaseState.ts'

/**
 * 检查 CaseState.symptoms 中哪些核心字段缺失。
 * 字段路径格式：'symptoms.duration' / 'symptoms.location' 等。
 */
export function getMissingCoreFields(state: CaseState, requiredFields: string[]): string[] {
  const missing: string[] = []
  for (const field of requiredFields) {
    // field 格式为 'symptoms.duration'
    const parts = field.split('.')
    if (parts.length !== 2 || parts[0] !== 'symptoms') continue
    const key = parts[1] as keyof CaseState['symptoms']
    const value = state.symptoms[key]
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      missing.push(field)
    }
  }
  return missing
}
```

### 3.4 文件：`server/agent/agentLoop.ts`

**修改 5**：在 R2 强制追问分支后，新增 R0/R1 强制追问分支。

当前代码（第 145-170 行，R2 分支结束后）：

```typescript
// ---- R2 且关键红旗未确认：优先风险核查追问 ----
if (state.risk.level === 'R2' && state.riskProbe.unresolvedRedFlags.length > 0 && state.riskProbe.probeStatus === 'in_progress') {
  // ... R2 强制追问逻辑 ...
}

// ---- 阶段 5：Agent 决策主循环 ----
let searchRelaxRetryUsed = false
// ...
```

目标代码（在 R2 分支后、阶段 5 前插入 R0/R1 分支）：

```typescript
// ---- R2 且关键红旗未确认：优先风险核查追问 ----
if (state.risk.level === 'R2' && state.riskProbe.unresolvedRedFlags.length > 0 && state.riskProbe.probeStatus === 'in_progress') {
  // ... R2 强制追问逻辑（不变） ...
}

// ---- R0/R1 且关键信息缺失：强制追问一次（避免信息不足直接分析） ----
if (
  (state.risk.level === 'R0' || state.risk.level === 'R1') &&
  !state.meta.mandatoryFollowupUsed &&
  state.meta.followupRounds === 0
) {
  const allDomains = [state.symptomDomain.primaryDomain, ...state.symptomDomain.secondaryDomains].filter(
    (d) => d !== 'unknown',
  )
  const requiredFields = getRequiredCoreFieldsForDomains(allDomains)
  const missingFields = getMissingCoreFields(state, requiredFields)

  if (missingFields.length > 0) {
    traceLogger.log(caseId, 'mandatory_followup_triggered', {
      missingFields,
      domains: allDomains,
    })
    emit({ type: 'status', message: '需要先补充关键信息，正在生成追问...' })

    const questionsResult = await runTool<FollowupOutput>('question.generate', {})

    if (questionsResult.status === 'success') {
      const checked = questionGuard.validate(
        toFollowups(questionsResult.output.questions, 'differential'),
        state,
      )
      traceLogger.log(caseId, 'question_guard', {
        output: { kept: checked.questions.map((q) => q.question), dropped: checked.dropped },
      })

      if (checked.questions.length > 0) {
        const maxQuestions = AGENT_LIMITS.maxQuestionsPerTurn
        const selectedQuestions = checked.questions.slice(0, maxQuestions)

        state = await caseStateService.recordAskedQuestions(caseId, selectedQuestions)
        state = await caseStateService.merge(caseId, {
          patch: {
            meta: { ...state.meta, mandatoryFollowupUsed: true },
          },
          updateReason: 'mandatory_followup_used',
          source: 'system',
        })
        const response = reportRenderer.renderFollowup({
          state,
          questions: selectedQuestions,
          mode: 'differential',
          intro: questionsResult.output.intro,
        })
        await messageService.appendAssistantMessage(
          caseId,
          JSON.stringify(selectedQuestions.map((q) => q.question)),
          'followup',
        )
        traceLogger.log(caseId, 'final_output', { reason: 'followup(mandatory_r0_r1)' })
        return response
      }
    }
    // 追问生成失败 / 问题全部被去重：继续主循环
  }
}

// ---- 阶段 5：Agent 决策主循环 ----
let searchRelaxRetryUsed = false
// ...
```

**修改 6**：在 `agentLoop.ts` 顶部导入新函数。

```typescript
import { getRequiredCoreFieldsForDomains } from './symptoms/symptomDomainConfig.ts'
import { getMissingCoreFields } from './case/stateFields.ts'
```

### 3.5 文件：`server/agent/decideAction.ts`

**修改 7**：`enforceConstraints` 新增 R0/R1 信息缺失检查（兜底）。

> **注意**：`agentLoop.ts` 的 R0/R1 分支是主入口，`decideAction.ts` 的检查是兜底（防止 `mandatoryFollowupUsed` 未触发但信息仍缺失时直接 `final_answer`）。

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

// ★ 新增：R0/R1 且关键信息缺失且未用过强制追问时，不允许 final_answer（兜底）
if (
  decision.action === 'final_answer' &&
  (state.risk.level === 'R0' || state.risk.level === 'R1') &&
  !state.meta.mandatoryFollowupUsed &&
  state.meta.followupRounds === 0
) {
  const allDomains = [state.symptomDomain.primaryDomain, ...state.symptomDomain.secondaryDomains].filter(
    (d) => d !== 'unknown',
  )
  const requiredFields = getRequiredCoreFieldsForDomains(allDomains)
  const missingFields = getMissingCoreFields(state, requiredFields)
  if (missingFields.length > 0) {
    return forcedDecision('ask_user', `关键信息缺失（${missingFields.join('、')}），应先追问补充。`)
  }
}

return decision
```

**修改 8**：在 `decideAction.ts` 顶部导入新函数。

```typescript
import { getRequiredCoreFieldsForDomains } from './symptoms/symptomDomainConfig.ts'
import { getMissingCoreFields } from './case/stateFields.ts'
```

---

## 4. 实施步骤

### 步骤 1：CaseState 新增字段

1. `Edit` `server/agent/case/CaseState.ts`，`CaseMeta` 新增 `mandatoryFollowupUsed` 字段。
2. `Edit` `createInitialCaseState`，初始化 `mandatoryFollowupUsed: false`。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 2：新增辅助函数

1. `Edit` `server/agent/symptoms/symptomDomainConfig.ts`，新增 `getRequiredCoreFieldsForDomains`。
2. `Edit` `server/agent/case/stateFields.ts`，新增 `getMissingCoreFields`。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 3：agentLoop 新增 R0/R1 分支

1. `Edit` `server/agent/agentLoop.ts`，导入新函数。
2. `Edit` 在 R2 分支后、阶段 5 前插入 R0/R1 强制追问分支。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 4：decideAction 兜底检查

1. `Edit` `server/agent/decideAction.ts`，导入新函数。
2. `Edit` `enforceConstraints`，新增 R0/R1 信息缺失兜底检查。
3. 验证：`npm run typecheck:api` + `npm run test:agent` 通过。

### 步骤 5：新增测试

1. `Edit` `server/agent/agent.v3.test.ts`，新增 R0/R1 强制追问测试。
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
// 测试 1：R0 且 requiredCoreFields 缺失时强制追问
test('R0/R1 强制追问：信息缺失时应触发追问', async () => {
  // 构造 state：risk.level='R0'，symptomDomain.primaryDomain='skin_mild'
  // symptoms.duration = undefined, symptoms.location = undefined
  // meta.followupRounds = 0, meta.mandatoryFollowupUsed = false
  // 执行 runCareCueAgent
  // 验证：返回 followup 响应
  // 验证：meta.mandatoryFollowupUsed = true
})

// 测试 2：mandatoryFollowupUsed 已用时不重复触发
test('R0/R1 强制追问：已用过时不重复触发', async () => {
  // 构造 state：meta.mandatoryFollowupUsed = true
  // 执行 runCareCueAgent
  // 验证：不触发强制追问，直接进入决策主循环
})

// 测试 3：R0 且信息完整时不触发强制追问
test('R0/R1 强制追问：信息完整时不触发', async () => {
  // 构造 state：risk.level='R0'，symptoms 所有 requiredCoreFields 已填充
  // 执行 runCareCueAgent
  // 验证：不触发强制追问，直接进入决策主循环
})

// 测试 4：R2 时不触发 R0/R1 强制追问（R2 有自己的追问分支）
test('R0/R1 强制追问：R2 时不触发', async () => {
  // 构造 state：risk.level='R2'
  // 执行 runCareCueAgent
  // 验证：走 R2 分支，不走 R0/R1 分支
})
```

---

## 7. 范围边界

### 在范围内

- `server/agent/case/CaseState.ts`（新增 `mandatoryFollowupUsed` 字段）
- `server/agent/symptoms/symptomDomainConfig.ts`（新增辅助函数）
- `server/agent/case/stateFields.ts`（新增辅助函数）
- `server/agent/agentLoop.ts`（R0/R1 分支）
- `server/agent/decideAction.ts`（兜底检查）
- `server/agent/agent.v3.test.ts`

### 不在范围内

- `canFinalAnswer` 门控（计划 005）
- 两阶段分析（计划 002）
- 多域识别（计划 001，本计划依赖其 `secondaryDomains`）

---

## 8. 维护说明

- `mandatoryFollowupUsed` 是一次性标志，确保 R0/R1 强制追问每轮对话最多触发一次。
- 如果用户在追问后仍未提供完整信息，`decideAction` 的兜底检查会再次拦截 `final_answer`，但此时会走 `ask_user`（由 LLM 决策），不再走强制追问。
- `getMissingCoreFields` 的字段路径格式为 `symptoms.<field>`，与 `symptomDomainConfig.ts` 中的 `requiredCoreFields` 定义一致。如果未来新增非 `symptoms.` 前缀的字段，需扩展该函数。

---

## 9. 回滚策略

如果 R0/R1 强制追问导致用户体验下降（频繁追问）：

1. `git checkout -- server/agent/agentLoop.ts server/agent/decideAction.ts`
2. `CaseState.ts` 的 `mandatoryFollowupUsed` 字段可保留（optional，不影响现有流程）。
3. 回滚后运行 `npm run test:agent` 确认基线恢复。
4. 如需调整触发条件（如只在特定域触发），修改 `agentLoop.ts` 中的 R0/R1 分支条件即可。
