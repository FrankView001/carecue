# 003 - 生活方式影响因素分析

> **优先级**：P1
> **影响**：中
> **工作量**：M
> **依赖**：[001](./001-multi-domain-symptom-analysis.md)
> **审计基线 commit**：`1628ad2`

---

## 1. 问题背景

用户反馈"痘痘"案例中，agent 未充分考虑熬夜、压力过大等生活因素对皮肤状况的影响。

### 根因（已确认）

**根因 1：symptomExtractor 已抽取 triggers，但 analyzeCase prompt 未要求分析其影响**

`server/agent/symptoms/symptomExtractor.ts` 第 33 行已定义 `triggers: z.array(z.string())`，且 `heuristicExtract` 第 138 行已能识别"熬夜"。但 `server/agent/llm/prompts/analyzeCase.prompt.ts` 的 `system` 中未要求 LLM 分析 triggers 对每个 hypothesis 的影响。

**根因 2：Hypothesis schema 无 triggerImpact 字段**

`server/agent/analysis/hypothesisSchema.ts` 的 `hypothesisSchema` 无结构化字段记录诱因影响，LLM 即使分析了也无法结构化输出。

---

## 2. 目标

1. `Hypothesis` 新增 `triggerImpact` 字段，结构化记录每个诱因对假设的影响。
2. `analyzeCase.prompt.ts` 的 `system` 强制要求 LLM 填写 `triggerImpact`。
3. `analyzeCase.prompt.ts` 的 `user` JSON 显式传入 `triggers`，避免 LLM 遗漏。

---

## 3. 修改清单

### 3.1 文件：`server/agent/analysis/hypothesisSchema.ts`

**修改 1**：`hypothesisSchema` 新增 `triggerImpact` 字段。

> **注意**：本计划与计划 002 都修改 `hypothesisSchema`，需合并修改。如果 002 已执行，在 002 的基础上新增 `triggerImpact`。

当前代码（第 5-15 行）：

```typescript
export const hypothesisSchema = z.object({
  name: z.string(),
  likelihood: z.enum(['more_likely', 'possible', 'less_likely', 'must_rule_out']),
  supportEvidence: z.array(z.string()),
  againstEvidence: z.array(z.string()),
  missingInfo: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high']),
  doctorCheckQuestion: z.string(),
  explanationForUser: z.string(),
  evidenceRefs: z.array(z.string()),
})
```

目标代码：

```typescript
export const triggerImpactSchema = z.object({
  trigger: z.string(),
  impact: z.string(),
  evidenceRefs: z.array(z.string()),
})

export const hypothesisSchema = z.object({
  name: z.string(),
  likelihood: z.enum(['more_likely', 'possible', 'less_likely', 'must_rule_out']),
  supportEvidence: z.array(z.string()),
  againstEvidence: z.array(z.string()),
  missingInfo: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high']),
  doctorCheckQuestion: z.string(),
  explanationForUser: z.string(),
  evidenceRefs: z.array(z.string()),
  /** 诱因影响分析（如"熬夜 → 皮脂分泌增加 → 加重痤疮"） */
  triggerImpact: z.array(triggerImpactSchema).optional(),
})
```

### 3.2 文件：`server/agent/case/CaseState.ts`

**修改 2**：`Hypothesis` 接口新增 `triggerImpact` 字段。

当前代码（第 100-110 行）：

```typescript
export interface Hypothesis {
  name: string
  likelihood: 'more_likely' | 'possible' | 'less_likely' | 'must_rule_out'
  supportEvidence: string[]
  againstEvidence: string[]
  missingInfo: string[]
  riskLevel: 'low' | 'medium' | 'high'
  doctorCheckQuestion: string
  explanationForUser: string
  evidenceRefs: string[]
}
```

目标代码：

```typescript
export interface TriggerImpact {
  trigger: string
  impact: string
  evidenceRefs: string[]
}

export interface Hypothesis {
  name: string
  likelihood: 'more_likely' | 'possible' | 'less_likely' | 'must_rule_out'
  supportEvidence: string[]
  againstEvidence: string[]
  missingInfo: string[]
  riskLevel: 'low' | 'medium' | 'high'
  doctorCheckQuestion: string
  explanationForUser: string
  evidenceRefs: string[]
  /** 诱因影响分析 */
  triggerImpact?: TriggerImpact[]
}
```

### 3.3 文件：`server/agent/llm/prompts/analyzeCase.prompt.ts`

**修改 3**：`system` 强制要求 `triggerImpact`。

> **注意**：计划 001 已在 `system` 中新增第 9、10 条要求，本计划确保第 10 条存在。如果 001 已执行，本步骤可跳过。

确认 `system` 中包含：

```typescript
10. 必须分析 triggers（诱因，如熬夜、压力、饮食、用药）对每个 hypothesis 的影响，在 triggerImpact 中填写。如果用户未提及诱因，triggerImpact 为空数组。
```

**修改 4**：`user` JSON 显式传入 `triggers`。

当前代码（第 33-43 行）：

```typescript
const user = JSON.stringify({
  symptoms: state.symptoms,
  userProfile: state.userProfile,
  symptomDomain: state.symptomDomain,
  risk: { level: state.risk.level, reason: state.risk.reason, redFlags: state.risk.redFlags },
  riskProbe: {
    redFlagDenied: state.riskProbe.redFlagDenied,
    unresolvedRedFlags: state.riskProbe.unresolvedRedFlags,
  },
  evidence: clipJson(evidenceForLlm, AGENT_LIMITS.maxEvidenceCharsForLLM),
  hypothesisSeeds: state.symptomDomain.primaryDomain,
  previousHypotheses: state.hypotheses.map((h) => h.name),
  askedQuestions: state.askedQuestions.map((q) => q.question),
})
```

`state.symptoms` 已包含 `triggers` 字段，但为避免 LLM 遗漏，显式提取：

目标代码：

```typescript
const user = JSON.stringify({
  symptoms: state.symptoms,
  // ★ 显式提示 LLM 关注诱因
  triggers: state.symptoms.triggers ?? [],
  userProfile: state.userProfile,
  symptomDomain: state.symptomDomain,
  risk: { level: state.risk.level, reason: state.risk.reason, redFlags: state.risk.redFlags },
  riskProbe: {
    redFlagDenied: state.riskProbe.redFlagDenied,
    unresolvedRedFlags: state.riskProbe.unresolvedRedFlags,
  },
  evidence: clipJson(evidenceForLlm, AGENT_LIMITS.maxEvidenceCharsForLLM),
  hypothesisSeeds: state.symptomDomain.primaryDomain,
  previousHypotheses: state.hypotheses.map((h) => h.name),
  askedQuestions: state.askedQuestions.map((q) => q.question),
})
```

### 3.4 文件：`server/agent/llm/prompts/understandSymptoms.prompt.ts`

**修改 5**：强化症状抽取阶段对 triggers 的捕获。

> **执行者需先 Read 该文件**，确认当前 prompt 是否已要求抽取 triggers。如果未要求，在 `system` 中新增：

```typescript
- 必须识别用户提及的诱因（triggers），包括但不限于：熬夜、睡眠不足、压力大、情绪波动、饮食（辛辣/甜食/酒精）、用药、化妆品使用、环境变化、季节变化。
- 如果用户未提及诱因，triggers 为空数组，不要编造。
```

### 3.5 文件：`server/agent/analysis/caseAnalyzer.ts`

**修改 6**：`sanitizeAnalysis` 保留 `triggerImpact` 字段。

当前 `sanitizeAnalysis` 使用 `{ ...h, ... }` 展开，会自动保留 `triggerImpact`，无需额外修改。但需确认 `toStatePatch` 正确传递：

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

`output.hypotheses as Hypothesis[]` 的类型转换会保留 `triggerImpact`，无需修改。

### 3.6 文件：`server/agent/report/reportRenderer.ts`（可选）

**修改 7**（可选）：在报告中展示 `triggerImpact`。

> **执行者需先 Read 该文件**，确认报告渲染逻辑。如果希望在报告中展示诱因影响，在 hypothesis 渲染部分新增 `triggerImpact` 展示。本步骤可选，不执行也不影响功能。

---

## 4. 实施步骤

### 步骤 1：Schema 变更

1. `Edit` `server/agent/analysis/hypothesisSchema.ts`，新增 `triggerImpactSchema` 和 `triggerImpact` 字段。
2. `Edit` `server/agent/case/CaseState.ts`，新增 `TriggerImpact` 接口和 `triggerImpact` 字段。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 2：更新 analyzeCase prompt

1. `Edit` `server/agent/llm/prompts/analyzeCase.prompt.ts`，确认 `system` 第 10 条存在。
2. `Edit` `user` JSON，显式传入 `triggers`。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 3：强化症状抽取 prompt

1. `Read` `server/agent/llm/prompts/understandSymptoms.prompt.ts`。
2. `Edit` `system`，新增诱因识别要求。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 4：新增测试

1. `Edit` `server/agent/agent.v3.test.ts`，新增诱因影响测试。
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
// 测试 1：triggers 非空时 hypothesis 应包含 triggerImpact
test('诱因影响：用户提及熬夜时 hypothesis 应分析 triggerImpact', async () => {
  // 构造 state：symptoms.triggers = ['熬夜']
  // 执行 case.analyze
  // 验证：至少 1 个 hypothesis 的 triggerImpact 非空
  // 验证：triggerImpact 中包含 trigger='熬夜'
})

// 测试 2：triggers 为空时 triggerImpact 为空数组
test('诱因影响：用户未提及诱因时 triggerImpact 为空', async () => {
  // 构造 state：symptoms.triggers = []
  // 执行 case.analyze
  // 验证：所有 hypothesis 的 triggerImpact 为空或 undefined
})
```

---

## 7. 范围边界

### 在范围内

- `server/agent/analysis/hypothesisSchema.ts`
- `server/agent/case/CaseState.ts`（新增字段）
- `server/agent/llm/prompts/analyzeCase.prompt.ts`
- `server/agent/llm/prompts/understandSymptoms.prompt.ts`
- `server/agent/agent.v3.test.ts`

### 不在范围内

- `reportRenderer.ts` 的诱因展示（可选，不强制）
- `caseAnalyzer.ts` 的两阶段重构（计划 002）
- `decideAction.ts` 的门控（计划 005）

---

## 8. 维护说明

- `triggerImpact` 是 optional 字段，LLM 未输出时不影响现有流程。
- 诱因识别依赖 `symptomExtractor` 的 triggers 字段，如果 `heuristicExtract`（LLM 不可用降级）未识别到诱因，`triggerImpact` 会为空，这是预期行为。
- 未来如需扩展诱因类型（如运动、旅行），在 `understandSymptoms.prompt.ts` 的要求列表中新增即可。

---

## 9. 回滚策略

如果 `triggerImpact` 导致 LLM 输出 schema 校验失败：

1. `git checkout -- server/agent/analysis/hypothesisSchema.ts server/agent/case/CaseState.ts`
2. prompt 中的第 10 条要求可保留（LLM 输出会被 schema 过滤，不影响功能）。
3. 回滚后运行 `npm run test:agent` 确认基线恢复。
