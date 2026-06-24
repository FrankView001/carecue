# 001 - 多域症状分析：消除"主域独占"

> **优先级**：P0
> **影响**：高
> **工作量**：M
> **依赖**：无（基础计划，其他计划依赖此计划）
> **审计基线 commit**：`1628ad2`

---

## 1. 问题背景

用户反馈"脸上长痘痘 + 身体紧绷"被直接判定为"痤疮"，"身体紧绷"被忽略。

### 根因（已确认）

**根因 1：触发词缺失**

`server/agent/symptoms/symptomDomainConfig.ts` 第 200-219 行，`generalDiscomfortDomain` 的 `triggerTerms` 不含"紧绷"、"僵硬"等词：

```typescript
const generalDiscomfortDomain: SymptomDomainConfig = {
  domain: 'general_discomfort',
  triggerTerms: ['没力气', '乏力', '疲劳', '不舒服', '难受', '没精神', '头晕'],
  // ...
}
```

**根因 2：secondaryDomains 未被消费**

`server/agent/symptoms/symptomDomainClassifier.ts` 第 95-107 行，`classifyByTriggerTerms` 返回 `secondaryDomains`，但后续 `riskProbe`、`caseAnalyze`、`followupGenerator` 只读取 `state.symptomDomain.primaryDomain`，从不读取 `secondaryDomains`。

```typescript
// symptomDomainClassifier.ts 第 95-107 行
const [primary, ...rest] = matches
return {
  primaryDomain: primary.domain,
  secondaryDomains: rest.map((m) => m.domain),  // ← 返回了但没人用
  triggerTerms: matches.flatMap((m) => m.terms),
  supportedDepth: primary.depth,
  reason: `触发词匹配：${primary.terms.join('、')}`,
}
```

**根因 3：riskProbe 只针对主域**

`server/agent/risk/riskProbe.ts`（未在本次审计中展开，但由 `agentLoop.ts` 第 110 行 `runTool('risk.probe', {})` 调用）仅基于 `state.symptomDomain.primaryDomain` 生成核查问题。

---

## 2. 目标

1. 扩充 `general_discomfort` 域触发词，覆盖"紧绷"、"僵硬"、"发紧"等表述。
2. `CaseState.symptomDomain` 新增 `domainWeights` 字段，记录每个命中域的权重。
3. `riskProbe` 支持对 `primaryDomain + secondaryDomains` 并行核查。
4. `caseAnalyze` 和 `followupGenerator` 的 prompt 中包含次域信息。

---

## 3. 修改清单

### 3.1 文件：`server/agent/symptoms/symptomDomainConfig.ts`

**修改 1**：扩充 `generalDiscomfortDomain.triggerTerms`。

当前代码（第 201 行）：

```typescript
triggerTerms: ['没力气', '乏力', '疲劳', '不舒服', '难受', '没精神', '头晕'],
```

目标代码：

```typescript
triggerTerms: ['没力气', '乏力', '疲劳', '不舒服', '难受', '没精神', '头晕', '紧绷', '发紧', '僵硬', '绷紧', '身体紧', '肌肉紧'],
```

**修改 2**：为 `generalDiscomfortDomain` 补充 `redFlagRuleIds`（当前只有 `GENERAL_KEY_INFO_MISSING`，建议补充 `GENERAL_WITH_RED_FLAG_SIGNALS`，但该规则需在 `redFlagRules.ts` 中定义，见计划 002 配套）。

**不在本计划范围**：不修改其他域的触发词。

### 3.2 文件：`server/agent/case/CaseState.ts`

**修改 3**：`SymptomDomainState` 新增 `domainWeights` 字段。

当前代码（第 41-47 行）：

```typescript
export interface SymptomDomainState {
  primaryDomain: SymptomDomain
  secondaryDomains: SymptomDomain[]
  triggerTerms: string[]
  supportedDepth: 'full' | 'red_flag_only'
  reason: string
}
```

目标代码：

```typescript
export interface SymptomDomainState {
  primaryDomain: SymptomDomain
  secondaryDomains: SymptomDomain[]
  triggerTerms: string[]
  supportedDepth: 'full' | 'red_flag_only'
  reason: string
  /** 每个命中域的归一化权重（0-1），按命中触发词数 × 域优先级计算 */
  domainWeights?: Partial<Record<SymptomDomain, number>>
}
```

**修改 4**：`RiskProbeState` 新增 `perDomainResults` 字段。

当前代码（第 56-66 行）：

```typescript
export interface RiskProbeState {
  symptomDomain: SymptomDomain
  triggerTerms: string[]
  requiredQuestions: FollowupQuestion[]
  redFlagConfirmed: string[]
  redFlagDenied: string[]
  unresolvedRedFlags: string[]
  probeStatus: 'not_started' | 'in_progress' | 'completed'
  canProceedToAnalysis: boolean
  reason: string
}
```

目标代码：

```typescript
export interface RiskProbeState {
  symptomDomain: SymptomDomain
  triggerTerms: string[]
  requiredQuestions: FollowupQuestion[]
  redFlagConfirmed: string[]
  redFlagDenied: string[]
  unresolvedRedFlags: string[]
  probeStatus: 'not_started' | 'in_progress' | 'completed'
  canProceedToAnalysis: boolean
  reason: string
  /** 按域分组的多域核查结果（多域识别时填充） */
  perDomainResults?: Array<{
    domain: SymptomDomain
    redFlagConfirmed: string[]
    redFlagDenied: string[]
    unresolvedRedFlags: string[]
  }>
}
```

**修改 5**：`createInitialCaseState` 无需修改（新字段 optional）。

### 3.3 文件：`server/agent/symptoms/symptomDomainClassifier.ts`

**修改 6**：`classifyByTriggerTerms` 计算并返回 `domainWeights`。

当前代码（第 95-107 行）：

```typescript
const [primary, ...rest] = matches
return {
  primaryDomain: primary.domain,
  secondaryDomains: rest.map((m) => m.domain),
  triggerTerms: matches.flatMap((m) => m.terms),
  supportedDepth: primary.depth,
  reason: `触发词匹配：${primary.terms.join('、')}`,
}
```

目标代码：

```typescript
// 按命中触发词数计算原始权重，再归一化
const rawWeights = matches.map((m) => ({ domain: m.domain, weight: m.terms.length }))
const totalWeight = rawWeights.reduce((sum, w) => sum + w.weight, 0)
const domainWeights: Partial<Record<SymptomDomain, number>> = {}
for (const w of rawWeights) {
  domainWeights[w.domain] = totalWeight > 0 ? w.weight / totalWeight : 0
}

const [primary, ...rest] = matches
return {
  primaryDomain: primary.domain,
  secondaryDomains: rest.map((m) => m.domain),
  triggerTerms: matches.flatMap((m) => m.terms),
  supportedDepth: primary.depth,
  reason: `触发词匹配：${matches.map((m) => `${m.domain}(${m.terms.join('、')})`).join('；')}`,
  domainWeights,
}
```

**修改 7**：`outputSchema` 新增 `domainWeights` 字段。

当前代码（第 18-25 行）：

```typescript
const outputSchema = z.object({
  primaryDomain: z.enum(SYMPTOM_DOMAINS),
  secondaryDomains: z.array(z.enum(SYMPTOM_DOMAINS)),
  triggerTerms: z.array(z.string()),
  supportedDepth: z.enum(['full', 'red_flag_only']),
  reason: z.string(),
})
```

目标代码：

```typescript
const outputSchema = z.object({
  primaryDomain: z.enum(SYMPTOM_DOMAINS),
  secondaryDomains: z.array(z.enum(SYMPTOM_DOMAINS)),
  triggerTerms: z.array(z.string()),
  supportedDepth: z.enum(['full', 'red_flag_only']),
  reason: z.string(),
  domainWeights: z.record(z.enum(SYMPTOM_DOMAINS), z.number()).optional(),
})
```

**修改 8**：`toStatePatch` 包含 `domainWeights`。

当前代码（第 70-79 行）：

```typescript
toStatePatch(output): Partial<CaseState> {
  return {
    symptomDomain: {
      primaryDomain: output.primaryDomain,
      secondaryDomains: output.secondaryDomains,
      triggerTerms: output.triggerTerms,
      supportedDepth: output.supportedDepth,
      reason: output.reason,
    },
  }
},
```

目标代码：

```typescript
toStatePatch(output): Partial<CaseState> {
  return {
    symptomDomain: {
      primaryDomain: output.primaryDomain,
      secondaryDomains: output.secondaryDomains,
      triggerTerms: output.triggerTerms,
      supportedDepth: output.supportedDepth,
      reason: output.reason,
      domainWeights: output.domainWeights,
    },
  }
},
```

### 3.4 文件：`server/agent/risk/riskProbe.ts`

**修改 9**：支持多域并行核查。

> **注意**：本计划审计中未展开 `riskProbe.ts` 全文，执行者需先 `Read` 该文件理解当前实现，再按以下目标修改。

目标行为：

- 读取 `state.symptomDomain.primaryDomain` + `state.symptomDomain.secondaryDomains`。
- 对每个域调用 `getDomainConfig(domain)` 获取 `riskProbeQuestions`。
- 合并所有域的 `riskProbeQuestions`，去重（按 `question` 文本）。
- 将每个域的核查结果填入 `perDomainResults`，同时合并到顶层的 `redFlagConfirmed / redFlagDenied / unresolvedRedFlags`。

**关键约束**：

- 不改变 `riskProbe` 工具的输入输出 schema（保持向后兼容）。
- `perDomainResults` 是新增字段，不影响现有消费方。
- 合并后的问题总数仍受 `AGENT_LIMITS.maxQuestionsPerTurn` 限制（在 `agentLoop.ts` 中截断）。

### 3.5 文件：`server/agent/llm/prompts/analyzeCase.prompt.ts`

**修改 10**：`user` JSON 中包含 `secondaryDomains` 和 `domainWeights`。

当前代码（第 33-43 行）：

```typescript
const user = JSON.stringify({
  symptoms: state.symptoms,
  userProfile: state.userProfile,
  symptomDomain: state.symptomDomain,
  // ...
})
```

`state.symptomDomain` 已包含 `secondaryDomains`，但 prompt 的 `system` 部分未要求 LLM 关注次域。

目标代码（在 `system` 中新增要求）：

```typescript
const system = `你是问康 CareCue 的病例分析助手。

要求：
1. 输出疑似疾病方向（hypotheses），不输出确诊；至少 1 个、最多 3 个主要方向。
2. 每个 hypothesis 必须有支持依据（supportEvidence），且必须有反对依据（againstEvidence）或不确定点（missingInfo）。
3. 可能性未必最高但风险较高、需要优先排除的方向，likelihood 必须标记 must_rule_out。
4. 排序依据：症状匹配度、病程匹配度、伴随症状、否认症状的排除力度、年龄/特殊人群相关性、风险严重程度、证据可信度。
5. 支持依据应尽量引用 evidence（写明 evidenceRefs 为证据 id）。
6. 必须判断：是否需要继续追问（shouldAskUser）、是否需要继续搜索（shouldSearchMore）、是否可以生成处理建议（shouldGenerateCarePlan）、是否可以最终回答（canFinalAnswer）。
7. 不允许只输出泛化建议，不允许把症状词直接当成急症结论。
8. explanationForUser 用普通用户能懂的话解释。
9. **必须同时分析 primaryDomain 和 secondaryDomains 涉及的方向**。如果用户有多个症状域命中（如皮肤 + 全身不适），hypotheses 必须覆盖每个域的常见方向，以及域之间的关联方向（如"熬夜导致皮脂分泌增加 + 全身疲劳感"）。
10. **必须分析 triggers（诱因，如熬夜、压力、饮食、用药）对每个 hypothesis 的影响**，在 triggerImpact 中填写。

只返回符合 JSON Schema 的 JSON。`
```

> **注意**：第 10 条要求的 `triggerImpact` 字段需要在 `hypothesisSchema.ts` 中新增，详见计划 [003](./003-lifestyle-factors-analysis.md)。本计划只修改 prompt 文字，schema 变更由 003 完成。如果 003 尚未执行，prompt 中的第 10 条不会生效（LLM 输出会被 schema 过滤），但不影响本计划的其他改动。

### 3.6 文件：`server/agent/llm/prompts/generateFollowup.prompt.ts`

**修改 11**：追问生成时包含次域的 missingInfo。

> **执行者需先 Read 该文件**，确认当前实现。目标：在 `user` JSON 中显式传入 `secondaryDomains` 的 `riskProbeQuestions` 和 `missingInfo`，让 LLM 能针对次域生成追问。

---

## 4. 实施步骤

### 步骤 1：扩充触发词

1. `Edit` `server/agent/symptoms/symptomDomainConfig.ts` 第 201 行，扩充 `generalDiscomfortDomain.triggerTerms`。
2. 验证：`npm run typecheck:api` 通过。

### 步骤 2：CaseState 新增字段

1. `Edit` `server/agent/case/CaseState.ts`，`SymptomDomainState` 新增 `domainWeights` 字段。
2. `Edit` `server/agent/case/CaseState.ts`，`RiskProbeState` 新增 `perDomainResults` 字段。
3. 验证：`npm run typecheck:api` 通过（新字段 optional，不破坏现有代码）。

### 步骤 3：重构 symptomDomainClassifier

1. `Edit` `server/agent/symptoms/symptomDomainClassifier.ts`，`outputSchema` 新增 `domainWeights`。
2. `Edit` `classifyByTriggerTerms` 函数，计算 `domainWeights`。
3. `Edit` `toStatePatch`，包含 `domainWeights`。
4. 验证：`npm run typecheck:api` + `npm run test:agent` 通过。

### 步骤 4：重构 riskProbe 支持多域

1. `Read` `server/agent/risk/riskProbe.ts` 全文。
2. `Edit` `riskProbe` 工具的 `call` 函数，遍历 `primaryDomain + secondaryDomains`，合并 `riskProbeQuestions`。
3. `Edit` `toStatePatch`，填充 `perDomainResults`。
4. 验证：`npm run typecheck:api` + `npm run test:agent` 通过。

### 步骤 5：更新 analyzeCase prompt

1. `Edit` `server/agent/llm/prompts/analyzeCase.prompt.ts`，`system` 新增第 9、10 条要求。
2. 验证：`npm run typecheck:api` 通过。

### 步骤 6：更新 generateFollowup prompt

1. `Read` `server/agent/llm/prompts/generateFollowup.prompt.ts`。
2. `Edit` `user` JSON，包含次域信息。
3. 验证：`npm run typecheck:api` + `npm run test:agent` 通过。

---

## 5. 验证命令

```powershell
npm run typecheck:api
npm run lint
npm run test:agent
```

**预期结果**：全部通过。`test:agent` 中的现有测试用例不应因多域改动而失败（新字段 optional，向后兼容）。

---

## 6. 测试计划

### 6.1 新增测试用例

在 `server/agent/agent.v3.test.ts` 中新增以下测试（参考现有测试的写法）：

```typescript
// 测试 1：多域触发词命中
test('多域识别：痘痘 + 身体紧绷 应同时命中 skin_mild 和 general_discomfort', async () => {
  const state = createInitialCaseState('test-multi-domain')
  state.symptoms.chiefComplaint = '脸上长痘痘'
  state.symptoms.associatedSymptoms = ['身体紧绷']
  state.symptoms.userOriginalText = ['最近脸上长痘痘，而且感觉人身体紧绷']

  const result = classifyByTriggerTerms(state)
  expect(result.primaryDomain).toBe('skin_mild')
  expect(result.secondaryDomains).toContain('general_discomfort')
  expect(result.domainWeights).toBeDefined()
  expect(result.domainWeights!.skin_mild).toBeGreaterThan(0)
  expect(result.domainWeights!.general_discomfort).toBeGreaterThan(0)
})

// 测试 2：单域命中不产生次域
test('单域识别：嗓子疼 不应产生次域', async () => {
  const state = createInitialCaseState('test-single-domain')
  state.symptoms.chiefComplaint = '嗓子疼'
  state.symptoms.userOriginalText = ['嗓子疼了 3 天']

  const result = classifyByTriggerTerms(state)
  expect(result.primaryDomain).toBe('throat_respiratory')
  expect(result.secondaryDomains).toHaveLength(0)
})
```

### 6.2 现有测试回归

`npm run test:agent` 中所有现有测试必须通过。如果现有测试硬编码了 `secondaryDomains: []`，需更新为 `secondaryDomains: expect.any(Array)`。

---

## 7. 范围边界

### 在范围内

- `server/agent/symptoms/symptomDomainConfig.ts`（仅 general_discomfort 触发词）
- `server/agent/symptoms/symptomDomainClassifier.ts`
- `server/agent/case/CaseState.ts`（新增 optional 字段）
- `server/agent/risk/riskProbe.ts`
- `server/agent/llm/prompts/analyzeCase.prompt.ts`（system 文字）
- `server/agent/llm/prompts/generateFollowup.prompt.ts`
- `server/agent/agent.v3.test.ts`（新增测试）

### 不在范围内

- `server/agent/analysis/caseAnalyzer.ts` 的两阶段重构（计划 002）
- `hypothesisSchema.ts` 的 `triggerImpact` 字段（计划 003）
- `decideAction.ts` 的 canFinalAnswer 门控（计划 005）
- `agentLoop.ts` 的 R0/R1 强制追问分支（计划 004）
- 其他症状域的触发词扩充（如需扩充其他域，另开计划）

---

## 8. 维护说明

- 未来新增症状域时，必须在 `SYMPTOM_DOMAIN_CONFIGS` 中注册，并确保 `triggerTerms` 覆盖该域的常见口语表述。
- `domainWeights` 的计算逻辑（触发词数归一化）是简单启发式，如未来需要更精细的权重（如基于 LLM 置信度），可在 `classifyByTriggerTerms` 中扩展，但需保持确定性（不引入 LLM 调用）。
- `perDomainResults` 是 optional 字段，消费方必须做 null 检查。

---

## 9. 回滚策略

如果改动导致 `test:agent` 大规模失败且无法快速修复：

1. `git checkout -- server/agent/symptoms/symptomDomainConfig.ts server/agent/symptoms/symptomDomainClassifier.ts server/agent/case/CaseState.ts`
2. 由于新字段全部 optional，`riskProbe.ts` 和 prompt 的改动可以单独保留或回滚，不影响现有流程。
3. 回滚后重新运行 `npm run test:agent` 确认基线恢复。
