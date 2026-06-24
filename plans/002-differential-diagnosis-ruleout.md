# 002 - 鉴别诊断"先排除后确认"流程

> **优先级**：P0
> **影响**：高
> **工作量**：L
> **依赖**：[001](./001-multi-domain-symptom-analysis.md)
> **审计基线 commit**：`1628ad2`

---

## 1. 问题背景

用户反馈"痘痘"被直接判定为"痤疮"，缺乏医学诊断中"先排除后确认"的专业流程。

### 根因（已确认）

**根因 1：analyzeCase prompt 未强制排除性证据**

`server/agent/llm/prompts/analyzeCase.prompt.ts` 第 8-19 行，要求每个 hypothesis 有"反对依据或不确定点"，但未要求对 `must_rule_out` 方向输出明确的排除性证据（如"无月经紊乱、无多毛"等否认症状）。

**根因 2：caseAnalyzer 未分阶段**

`server/agent/analysis/caseAnalyzer.ts` 第 35-50 行，单次 LLM 调用生成所有 hypotheses，没有"先排除高风险 → 再确认主要方向"的两阶段流程。

**根因 3：decideAction 未检查 must_rule_out 是否被处理**

`server/agent/decideAction.ts` 的 `enforceConstraints` 函数（第 51-100 行）检查了 `hypotheses.length === 0` 等条件，但未检查 `must_rule_out` 方向是否有排除结论，允许在 must_rule_out 未处理时直接 `final_answer`。

---

## 2. 目标

1. `caseAnalyzer` 重构为两阶段：阶段 A（ruleout）排除 must_rule_out 方向，阶段 B（confirm）排序并确认主要方向。
2. `CaseState` 新增 `ruleoutEvidence` 字段，持久化排除结论。
3. `Hypothesis` 新增 `ruleoutStatus` 字段，标记每个方向的排除状态。
4. `decideAction` 在 `final_answer` 前检查所有 must_rule_out 已处理（由计划 005 完成）。

---

## 3. 修改清单

### 3.1 文件：`server/agent/analysis/hypothesisSchema.ts`

**修改 1**：`hypothesisSchema` 新增 `ruleoutStatus` 字段。

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
  /** 排除状态：ruled_out（已排除）/ cannot_rule_out（无法排除）/ not_applicable（非 must_rule_out 方向）/ pending（待处理） */
  ruleoutStatus: z.enum(['ruled_out', 'cannot_rule_out', 'not_applicable', 'pending']).optional(),
})
```

**修改 2**：`caseAnalyzeOutputSchema` 新增 `analysisStage` 和 `allRuleoutsResolved` 字段。

当前代码（第 27-35 行）：

```typescript
export const caseAnalyzeOutputSchema = z.object({
  hypotheses: z.array(hypothesisSchema).min(1).max(5),
  missingInfo: z.array(missingInfoSchema),
  stageConclusion: z.string(),
  canFinalAnswer: z.boolean(),
  shouldAskUser: z.boolean(),
  shouldSearchMore: z.boolean(),
  shouldGenerateCarePlan: z.boolean(),
})
```

目标代码：

```typescript
export const caseAnalyzeOutputSchema = z.object({
  hypotheses: z.array(hypothesisSchema).min(1).max(5),
  missingInfo: z.array(missingInfoSchema),
  stageConclusion: z.string(),
  canFinalAnswer: z.boolean(),
  shouldAskUser: z.boolean(),
  shouldSearchMore: z.boolean(),
  shouldGenerateCarePlan: z.boolean(),
  /** 分析阶段标记：ruleout（阶段 A）/ confirm（阶段 B）/ single（降级单阶段） */
  analysisStage: z.enum(['ruleout', 'confirm', 'single']).optional(),
  /** 是否所有 must_rule_out 方向已处理（ruled_out 或 cannot_rule_out） */
  allRuleoutsResolved: z.boolean().optional(),
})
```

### 3.2 文件：`server/agent/case/CaseState.ts`

**修改 3**：`CaseState` 新增 `ruleoutEvidence` 字段。

在 `CaseState` 接口中（第 134-150 行附近），`hypotheses` 字段后新增：

```typescript
export interface RuleoutEvidence {
  hypothesisName: string
  status: 'ruled_out' | 'cannot_rule_out' | 'inconclusive'
  evidence: string[]
  evidenceRefs: string[]
  reason: string
}

export interface CaseState {
  // ... 现有字段 ...
  hypotheses: Hypothesis[]
  /** ★ 新增：排除性证据记录（鉴别诊断阶段 A 产出） */
  ruleoutEvidence?: RuleoutEvidence[]
  carePlan?: CarePlan
  // ... 其他现有字段 ...
}
```

**修改 4**：`Hypothesis` 接口新增 `ruleoutStatus` 字段。

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
  /** 排除状态（由鉴别诊断阶段 A 填充） */
  ruleoutStatus?: 'ruled_out' | 'cannot_rule_out' | 'not_applicable' | 'pending'
}
```

### 3.3 文件：`server/agent/llm/prompts/analyzeCase.prompt.ts`

**修改 5**：新增 `buildRuleoutPrompt` 函数（阶段 A 专用 prompt）。

在文件末尾新增：

```typescript
export function buildRuleoutPrompt(state: CaseState) {
  const system = `你是问康 CareCue 的鉴别诊断助手，当前处于"排除阶段"（ruleout）。

任务：
1. 从 previousHypotheses 中识别所有 likelihood === 'must_rule_out' 的方向。
2. 对每个 must_rule_out 方向，基于现有 symptoms、evidence、riskProbe 结果，判断：
   - ruled_out：有明确排除性证据（如否认症状、证据不支持）→ 填写 evidence 和 reason
   - cannot_rule_out：现有信息不足以排除 → 填写 reason 说明缺什么
   - inconclusive：证据矛盾 → 填写 reason
3. 如果没有 must_rule_out 方向，输出 allRuleoutsResolved: true，ruleoutEvidence 为空数组。
4. 不允许凭"症状不常见"直接排除，必须有明确的否认症状或证据不支持。

只返回符合 JSON Schema 的 JSON。`

  const mustRuleOuts = state.hypotheses.filter((h) => h.likelihood === 'must_rule_out')

  const user = JSON.stringify({
    symptoms: state.symptoms,
    riskProbe: {
      redFlagDenied: state.riskProbe.redFlagDenied,
      redFlagConfirmed: state.riskProbe.redFlagConfirmed,
    },
    evidence: state.evidence.map((e) => ({
      id: e.id,
      summary: e.summary,
      facts: e.extractedFacts,
    })),
    mustRuleOutHypotheses: mustRuleOuts.map((h) => ({
      name: h.name,
      supportEvidence: h.supportEvidence,
      againstEvidence: h.againstEvidence,
    })),
  })

  return { system, user }
}
```

**修改 6**：修改 `buildAnalyzeCasePrompt` 的 `system`，要求阶段 B 基于 ruleout 结果排序。

在现有 `system` 中新增第 11 条要求：

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
9. 必须同时分析 primaryDomain 和 secondaryDomains 涉及的方向。
10. 必须分析 triggers 对每个 hypothesis 的影响（在 triggerImpact 中填写）。
11. **如果输入包含 ruleoutEvidence，必须基于排除结果排序**：ruled_out 的方向 likelihood 降为 less_likely；cannot_rule_out 的方向保持 must_rule_out 并在 missingInfo 中说明需要补充什么才能排除。每个 hypothesis 的 ruleoutStatus 必须与 ruleoutEvidence 一致。

只返回符合 JSON Schema 的 JSON。`
```

**修改 7**：`buildAnalyzeCasePrompt` 的 `user` JSON 包含 `ruleoutEvidence`。

在 `user` JSON 中新增字段：

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
  // ★ 新增
  ruleoutEvidence: state.ruleoutEvidence ?? [],
})
```

### 3.4 文件：`server/agent/analysis/caseAnalyzer.ts`

**修改 8**：新增 `ruleoutSchema`（阶段 A 输出 schema）。

在文件顶部新增：

```typescript
const ruleoutSchema = z.object({
  ruleoutEvidence: z.array(z.object({
    hypothesisName: z.string(),
    status: z.enum(['ruled_out', 'cannot_rule_out', 'inconclusive']),
    evidence: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    reason: z.string(),
  })),
  allRuleoutsResolved: z.boolean(),
})

export type RuleoutOutput = z.infer<typeof ruleoutSchema>
```

**修改 9**：新增 `caseRuleoutTool`（阶段 A 工具）。

在 `caseAnalyzeTool` 定义之前新增：

```typescript
export const caseRuleoutTool = defineTool({
  name: 'case.ruleout',
  description: '鉴别诊断排除阶段：对 must_rule_out 方向输出排除性证据。',
  inputSchema: z.object({}),
  outputSchema: ruleoutSchema,
  guardLevel: 'medical_reasoning',
  timeoutMs: 30000,

  guard(_input, state) {
    const emergency = blockWhenEmergency(state)
    if (!emergency.allowed) return emergency
    return requireSymptoms(state)
  },

  async call(_input, ctx) {
    // 没有 must_rule_out 方向时直接返回
    const mustRuleOuts = ctx.state.hypotheses.filter((h) => h.likelihood === 'must_rule_out')
    if (mustRuleOuts.length === 0) {
      return {
        ruleoutEvidence: [],
        allRuleoutsResolved: true,
      }
    }

    try {
      const prompt = buildRuleoutPrompt(ctx.state)
      return await ctx.llm.structured({
        schema: ruleoutSchema,
        schemaName: 'case_ruleout',
        system: prompt.system,
        user: prompt.user,
        temperature: 0.1,
      })
    } catch (error) {
      if (!(error instanceof LlmUnavailableError)) throw error
      ctx.traceLogger.log(ctx.caseId, 'llm_fallback', { reason: 'case.ruleout 降级为全部 cannot_rule_out' })
      return {
        ruleoutEvidence: mustRuleOuts.map((h) => ({
          hypothesisName: h.name,
          status: 'cannot_rule_out' as const,
          evidence: [],
          evidenceRefs: [],
          reason: 'AI 排除分析暂不可用，建议医生面诊确认。',
        })),
        allRuleoutsResolved: false,
      }
    }
  },

  toStatePatch(output): Partial<CaseState> {
    return {
      ruleoutEvidence: output.ruleoutEvidence,
    }
  },

  toTrace(output) {
    return {
      output: output.ruleoutEvidence.map((r) => `${r.hypothesisName}: ${r.status}`),
    }
  },
})
```

**修改 10**：修改 `caseAnalyzeTool` 的 `sanitizeAnalysis`，基于 `ruleoutEvidence` 更新 `ruleoutStatus`。

当前代码（第 79-92 行）：

```typescript
function sanitizeAnalysis(output: CaseAnalyzeOutput, state: CaseState): CaseAnalyzeOutput {
  const mustRuleOut = output.hypotheses.filter((h) => h.likelihood === 'must_rule_out')
  const others = output.hypotheses.filter((h) => h.likelihood !== 'must_rule_out').slice(0, 3)

  const hypotheses = [...others, ...mustRuleOut].map((h) => {
    if (h.againstEvidence.length === 0 && h.missingInfo.length === 0) {
      return { ...h, missingInfo: ['当前信息不足以排除其他方向，需要医生面诊确认。'] }
    }
    return h
  })

  const canFinalAnswer = output.canFinalAnswer && state.evidence.length > 0

  return { ...output, hypotheses, canFinalAnswer }
}
```

目标代码：

```typescript
function sanitizeAnalysis(output: CaseAnalyzeOutput, state: CaseState): CaseAnalyzeOutput {
  const mustRuleOut = output.hypotheses.filter((h) => h.likelihood === 'must_rule_out')
  const others = output.hypotheses.filter((h) => h.likelihood !== 'must_rule_out').slice(0, 3)

  // 基于 ruleoutEvidence 更新每个 hypothesis 的 ruleoutStatus
  const ruleoutMap = new Map(
    (state.ruleoutEvidence ?? []).map((r) => [r.hypothesisName, r.status]),
  )

  const hypotheses = [...others, ...mustRuleOut].map((h) => {
    let ruleoutStatus: Hypothesis['ruleoutStatus']
    if (h.likelihood !== 'must_rule_out') {
      ruleoutStatus = 'not_applicable'
    } else {
      const status = ruleoutMap.get(h.name)
      if (status === 'ruled_out') {
        ruleoutStatus = 'ruled_out'
        // 已排除的方向降级为 less_likely
        h = { ...h, likelihood: 'less_likely' }
      } else if (status === 'cannot_rule_out') {
        ruleoutStatus = 'cannot_rule_out'
      } else {
        ruleoutStatus = 'pending'
      }
    }

    if (h.againstEvidence.length === 0 && h.missingInfo.length === 0) {
      return {
        ...h,
        ruleoutStatus,
        missingInfo: ['当前信息不足以排除其他方向，需要医生面诊确认。'],
      }
    }
    return { ...h, ruleoutStatus }
  })

  const canFinalAnswer = output.canFinalAnswer && state.evidence.length > 0

  // 所有 must_rule_out 方向已处理（ruled_out 或 cannot_rule_out）
  const allRuleoutsResolved = mustRuleOut.every((h) => {
    const status = ruleoutMap.get(h.name)
    return status === 'ruled_out' || status === 'cannot_rule_out'
  })

  return {
    ...output,
    hypotheses,
    canFinalAnswer,
    allRuleoutsResolved,
    analysisStage: 'confirm',
  }
}
```

### 3.5 文件：`server/agent/tools/ToolRegistry.ts`

**修改 11**：注册 `case.ruleout` 工具。

> **执行者需先 Read 该文件**，按现有工具注册模式新增 `caseRuleoutTool`。

### 3.6 文件：`server/agent/agentLoop.ts`

**修改 12**：在 `analyze_case` 分支中编排两阶段。

当前代码（第 357-371 行）：

```typescript
case 'analyze_case': {
  emit({ type: 'status', message: '正在分析可能的疾病方向...' })
  const result = await runTool<CaseAnalyzeOutput>('case.analyze', {})
  if (result.status === 'error') {
    return finish(await failureRecovery.handle({ code: result.message.error!.code, state }))
  }
  await messageService.appendToolResult(caseId, result.message)
  state = await caseStateService.merge(caseId, {
    patch: result.statePatch,
    updateReason: 'case_analyzed',
    source: 'tool',
  })
  traceLogger.log(caseId, 'hypotheses_updated', {
    output: state.hypotheses.map((h) => `${h.name}(${h.likelihood})`),
  })
  continue
}
```

目标代码：

```typescript
case 'analyze_case': {
  emit({ type: 'status', message: '正在分析可能的疾病方向...' })

  // 阶段 A：首次分析（无 hypotheses 时）— 单次 LLM 生成初始方向
  if (state.hypotheses.length === 0) {
    const result = await runTool<CaseAnalyzeOutput>('case.analyze', {})
    if (result.status === 'error') {
      return finish(await failureRecovery.handle({ code: result.message.error!.code, state }))
    }
    await messageService.appendToolResult(caseId, result.message)
    state = await caseStateService.merge(caseId, {
      patch: result.statePatch,
      updateReason: 'case_analyzed_initial',
      source: 'tool',
    })
    traceLogger.log(caseId, 'hypotheses_updated', {
      output: state.hypotheses.map((h) => `${h.name}(${h.likelihood})`),
    })
    continue
  }

  // 阶段 B：已有 hypotheses 且有 must_rule_out 未处理 → 先 ruleout 再 analyze
  const hasUnresolvedRuleouts = state.hypotheses.some(
    (h) => h.likelihood === 'must_rule_out' && (!h.ruleoutStatus || h.ruleoutStatus === 'pending'),
  )

  if (hasUnresolvedRuleouts && !state.ruleoutEvidence) {
    emit({ type: 'status', message: '正在排除高风险方向...' })
    const ruleoutResult = await runTool<RuleoutOutput>('case.ruleout', {})
    if (ruleoutResult.status === 'success') {
      await messageService.appendToolResult(caseId, ruleoutResult.message)
      state = await caseStateService.merge(caseId, {
        patch: ruleoutResult.statePatch,
        updateReason: 'case_ruleout_completed',
        source: 'tool',
      })
      traceLogger.log(caseId, 'ruleout_completed', { output: ruleoutResult.output })
    }
    // ruleout 后继续 analyze（基于 ruleoutEvidence 重新排序）
    nextDecisionDeterministic = true
    continue
  }

  // 阶段 C：已有 ruleoutEvidence → 基于 ruleout 重新分析
  if (state.ruleoutEvidence) {
    const result = await runTool<CaseAnalyzeOutput>('case.analyze', {})
    if (result.status === 'error') {
      return finish(await failureRecovery.handle({ code: result.message.error!.code, state }))
    }
    await messageService.appendToolResult(caseId, result.message)
    state = await caseStateService.merge(caseId, {
      patch: result.statePatch,
      updateReason: 'case_analyzed_with_ruleout',
      source: 'tool',
    })
    traceLogger.log(caseId, 'hypotheses_updated', {
      output: state.hypotheses.map((h) => `${h.name}(${h.likelihood},${h.ruleoutStatus ?? 'n/a'})`),
    })
    continue
  }

  // 兜底：直接分析
  const result = await runTool<CaseAnalyzeOutput>('case.analyze', {})
  if (result.status === 'error') {
    return finish(await failureRecovery.handle({ code: result.message.error!.code, state }))
  }
  await messageService.appendToolResult(caseId, result.message)
  state = await caseStateService.merge(caseId, {
    patch: result.statePatch,
    updateReason: 'case_analyzed',
    source: 'tool',
  })
  continue
}
```

**修改 13**：在 `agentLoop.ts` 顶部导入 `RuleoutOutput` 类型。

```typescript
import type { RuleoutOutput } from './analysis/caseAnalyzer.ts'
```

---

## 4. 实施步骤

### 步骤 1：Schema 变更

1. `Edit` `server/agent/analysis/hypothesisSchema.ts`，新增 `ruleoutStatus` / `analysisStage` / `allRuleoutsResolved` 字段。
2. `Edit` `server/agent/case/CaseState.ts`，新增 `RuleoutEvidence` 接口和 `ruleoutEvidence` 字段，`Hypothesis` 新增 `ruleoutStatus`。
3. 验证：`npm run typecheck:api` 通过。

### 步骤 2：新增 ruleout prompt

1. `Edit` `server/agent/llm/prompts/analyzeCase.prompt.ts`，新增 `buildRuleoutPrompt` 函数。
2. `Edit` `buildAnalyzeCasePrompt` 的 `system`，新增第 11 条要求。
3. `Edit` `buildAnalyzeCasePrompt` 的 `user` JSON，包含 `ruleoutEvidence`。
4. 验证：`npm run typecheck:api` 通过。

### 步骤 3：新增 caseRuleoutTool

1. `Edit` `server/agent/analysis/caseAnalyzer.ts`，新增 `ruleoutSchema` 和 `caseRuleoutTool`。
2. `Edit` `sanitizeAnalysis`，基于 `ruleoutEvidence` 更新 `ruleoutStatus`。
3. `Read` `server/agent/tools/ToolRegistry.ts`，注册 `caseRuleoutTool`。
4. 验证：`npm run typecheck:api` 通过。

### 步骤 4：编排两阶段分析

1. `Edit` `server/agent/agentLoop.ts`，导入 `RuleoutOutput` 类型。
2. `Edit` `analyze_case` 分支，实现三阶段编排（初始 / ruleout / confirm）。
3. 验证：`npm run typecheck:api` + `npm run test:agent` 通过。

### 步骤 5：新增测试

1. `Edit` `server/agent/agent.v3.test.ts`，新增两阶段分析测试。
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
// 测试 1：有 must_rule_out 时触发 ruleout 阶段
test('鉴别诊断：有 must_rule_out 方向时应先 ruleout 再 confirm', async () => {
  // 构造 state：已有 hypotheses，其中 1 个 must_rule_out
  // 执行 analyze_case
  // 验证：先调用 case.ruleout，再调用 case.analyze
  // 验证：ruleoutEvidence 被填充
  // 验证：must_rule_out 方向的 ruleoutStatus 不是 pending
})

// 测试 2：无 must_rule_out 时跳过 ruleout
test('鉴别诊断：无 must_rule_out 方向时直接 analyze', async () => {
  // 构造 state：已有 hypotheses，无 must_rule_out
  // 执行 analyze_case
  // 验证：不调用 case.ruleout
  // 验证：ruleoutEvidence 为空
})

// 测试 3：ruleout 降级（LLM 不可用）
test('鉴别诊断：LLM 不可用时 ruleout 降级为 cannot_rule_out', async () => {
  // mock LLM 抛出 LlmUnavailableError
  // 执行 case.ruleout
  // 验证：所有 must_rule_out 方向 status 为 cannot_rule_out
})
```

---

## 7. 范围边界

### 在范围内

- `server/agent/analysis/hypothesisSchema.ts`
- `server/agent/analysis/caseAnalyzer.ts`
- `server/agent/case/CaseState.ts`（新增字段）
- `server/agent/llm/prompts/analyzeCase.prompt.ts`
- `server/agent/tools/ToolRegistry.ts`（注册新工具）
- `server/agent/agentLoop.ts`（analyze_case 分支编排）
- `server/agent/agent.v3.test.ts`

### 不在范围内

- `decideAction.ts` 的 `final_answer` 门控（计划 005）
- `triggerImpact` 字段（计划 003）
- 报告渲染器对 `ruleoutStatus` 的展示（可后续优化，当前报告不展示该字段也不报错）

---

## 8. 维护说明

- `case.ruleout` 工具的 `guardLevel` 为 `medical_reasoning`，与 `case.analyze` 一致，受相同的安全约束。
- 两阶段分析会增加 1 次 LLM 调用（ruleout），但 `maxAgentSteps=7` 的限制不变，需注意步数预算。如果步数紧张，可通过 `nextDecisionDeterministic` 跳过 ruleout 后的决策 LLM 调用。
- `ruleoutEvidence` 是 optional 字段，`finalAnswerGuard` 不依赖它，但计划 005 的 `decideAction` 门控会依赖它。

---

## 9. 回滚策略

如果两阶段分析导致 `maxAgentSteps` 频繁超限或测试大规模失败：

1. 将 `agentLoop.ts` 的 `analyze_case` 分支回滚为单阶段（`git checkout -- server/agent/agentLoop.ts`）。
2. `caseRuleoutTool` 和 schema 新字段可保留（optional，不影响现有流程）。
3. 回滚后运行 `npm run test:agent` 确认基线恢复。
