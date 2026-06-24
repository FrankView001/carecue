# 000 - 新版 CareCue Agent 完整设计方案

> **文档性质**：基于 `/improve` skill 对现有代码审计后产出的新版 agent 设计方案。
> **审计基线**：commit `1628ad2`
> **触发场景**：用户反馈"脸上长痘痘 + 身体紧绷"被直接判定为"痤疮"，暴露四类逻辑缺陷：症状分析不全面、因果关系判断错误、影响因素考虑不足、诊断逻辑不严谨。

---

## 1. 设计目标

将现有"主域独占 + 单向线性分析"的 agent 升级为"多域协同 + 鉴别诊断优先"的 agent，核心目标：

1. **症状采集标准化**：完整捕获主诉 + 伴随症状 + 诱因 + 否认症状，不丢信息。
2. **多域协同识别**：主域 + 次域同时进入后续流程，次域不被丢弃。
3. **鉴别诊断步骤化**：强制"先排除高风险（must_rule_out）→ 再确认主要方向"流程，每个方向必须有反对依据或排除性证据。
4. **影响因素分析**：熬夜、压力、饮食、用药等诱因必须纳入每个假设的影响评估。
5. **概率评估可解释**：likelihood 排序有明确依据，不允许"症状词直接当结论"。
6. **安全边界不退化**：保留现有 R3 急症直出、用药边界守卫、最终报告守卫等所有安全机制。

---

## 2. 架构设计

### 2.1 总体架构（保持不变的部分）

沿用 v3.0 文档定义的分层架构：

```
┌─────────────────────────────────────────────────────────┐
│  agentLoop.ts（主循环编排）                              │
│  阶段 1-4 确定性流水线 + 阶段 5 LLM 决策主循环           │
└──────────────┬──────────────────────────────────────────┘
               │
   ┌───────────┼───────────┬───────────┬───────────────┐
   ▼           ▼           ▼           ▼               ▼
症状抽取     域识别       风险核查     决策            分析/报告
symptoms/    symptoms/    risk/       decideAction   analysis/
                         redFlagRules                report/
                                                         │
                                                         ▼
                                              safety/（守卫）
                                              tools/（工具抽象）
                                              case/（CaseState）
```

**保持不变的理由**：分层清晰、职责单一、CaseState 串行合并模型已验证可靠。本次改进聚焦"分析深度"而非"架构重构"。

### 2.2 新版架构（变更部分）

#### 变更 1：症状域识别输出"多域权重"而非"主域独占"

```
旧：primaryDomain + secondaryDomains[]（secondaryDomains 后续不使用）
新：primaryDomain + secondaryDomains[] + domainWeights: { [domain]: weight }
    + 每个命中的域都生成独立的 riskProbe 子问题集
```

#### 变更 2：风险核查阶段对每个命中域并行执行

```
旧：仅对 primaryDomain 执行 riskProbe
新：对 primaryDomain + secondaryDomains 各自执行 riskProbe，
    合并 redFlagConfirmed / redFlagDenied / unresolvedRedFlags
```

#### 变更 3：病例分析阶段引入"鉴别诊断工作流"

```
旧：单次 LLM 调用生成 hypotheses
新：两阶段
    阶段 A（ruleout）：针对每个 must_rule_out 方向，要求 LLM 输出排除性证据或确认无法排除
    阶段 B（confirm）：基于排除结果，重新排序 hypotheses，要求每个方向有诱因影响分析
```

#### 变更 4：决策层引入"信息完备性门控"

```
旧：R0/R1 即使信息缺失也可能直接 analyze_case → final_answer
新：R0/R1 且关键信息缺失时，强制 ask_user 一次；
    final_answer 前置检查 canFinalAnswer 且 must_rule_out 已处理
```

---

## 3. 功能模块划分

### 3.1 模块清单（标注变更类型）

| 模块 | 路径 | 变更类型 | 说明 |
|------|------|----------|------|
| 症状抽取 | `server/agent/symptoms/symptomExtractor.ts` | 增强 | 抽取诱因（triggers）字段已存在，需在 prompt 中强化要求 |
| 症状域识别 | `server/agent/symptoms/symptomDomainClassifier.ts` | **重构** | 输出多域权重，不再"主域独占" |
| 症状域配置 | `server/agent/symptoms/symptomDomainConfig.ts` | 增强 | 扩充 general_discomfort 触发词（紧绷、僵硬等） |
| 风险核查 | `server/agent/risk/riskProbe.ts` | **重构** | 支持多域并行核查 |
| 红旗规则 | `server/agent/risk/redFlagRules.ts` | 增强 | 为 general_discomfort 补充红旗规则 |
| 病例分析 | `server/agent/analysis/caseAnalyzer.ts` | **重构** | 两阶段：ruleout → confirm |
| 分析 Prompt | `server/agent/llm/prompts/analyzeCase.prompt.ts` | **重写** | 强制排除性证据 + 诱因影响分析 |
| 假设 Schema | `server/agent/analysis/hypothesisSchema.ts` | 增强 | 新增 `ruleoutStatus` / `triggerImpact` 字段 |
| 决策器 | `server/agent/decideAction.ts` | 增强 | R0/R1 强制追问 + canFinalAnswer 门控 |
| 决策 Prompt | `server/agent/llm/prompts/decideAction.prompt.ts` | 增强 | 传递 canFinalAnswer / ruleoutStatus |
| 主循环 | `server/agent/agentLoop.ts` | 增强 | R0/R1 强制追问分支 + 两阶段分析编排 |
| CaseState | `server/agent/case/CaseState.ts` | 增强 | 新增 domainWeights / ruleoutEvidence 字段 |
| 追问生成 | `server/agent/question/followupGenerator.ts` | 增强 | 基于多域 missingInfo 生成追问 |

### 3.2 不变模块（明确边界）

- `server/agent/tools/Tool.ts` / `ToolExecutor.ts` / `ToolRegistry.ts`：工具抽象不变
- `server/agent/safety/*`：所有安全守卫不变（certaintyGuard / medicationBoundaryGuard / finalAnswerGuard / emergencyOutputGuard）
- `server/agent/search/*`：搜索管线不变
- `server/agent/evidence/*`：证据抽取/校验/聚合不变
- `server/agent/report/*`：报告生成/渲染不变（但消费的 state 字段更多）
- `server/agent/llm/llmClient.ts`：LLM 客户端抽象不变
- `server/agent/failureRecovery.ts`：失败恢复不变

---

## 4. 交互流程设计

### 4.1 新版完整流程

```
用户消息
  │
  ▼
[阶段 1] 症状抽取（symptom.extract）
  │  输出：chiefComplaint + associatedSymptoms + triggers + negativeSymptoms
  ▼
[阶段 2] 症状域识别（symptom.domain_classify）★ 改进
  │  输出：primaryDomain + secondaryDomains + domainWeights
  │  每个 hit 域都保留，按权重排序
  ▼
[阶段 3] 多域风险核查（risk.probe）★ 改进
  │  对 primaryDomain + secondaryDomains 各自执行 riskProbe
  │  合并 redFlagConfirmed / redFlagDenied / unresolvedRedFlags
  ▼
[阶段 4] 红旗规则评估（risk.red_flag_assess）
  │  R3 → 急症直出（不变）
  │  R2 + unresolvedRedFlags → 风险核查追问（不变）
  │  R0/R1 + 关键信息缺失 → ★ 新增：强制 ask_user 一次
  ▼
[阶段 5] Agent 决策主循环
  │
  ├─ analyze_case（★ 两阶段）
  │   ├─ 阶段 A：ruleout — 对每个 must_rule_out 方向输出排除性证据
  │   └─ 阶段 B：confirm — 基于排除结果排序 + 诱因影响分析
  │
  ├─ search_medical（不变）
  ├─ ask_user（不变，但 missingInfo 来源更丰富）
  ├─ generate_care_plan（不变）
  │
  └─ final_answer（★ 门控增强）
      │  前置检查：
      │  1. canFinalAnswer === true
      │  2. 所有 must_rule_out 方向有 ruleoutStatus（ruled_out / cannot_rule_out）
      │  3. 每个主要方向有 triggerImpact 分析
      │
      ▼
  最终报告（finalAnswerGuard 复核，不变）
```

### 4.2 关键交互变更说明

#### 4.2.1 多域识别后的追问策略

当用户说"脸上长痘痘，身体紧绷"时：

- **旧流程**：primaryDomain = skin_mild（痤疮触发词命中），secondaryDomains = [general_discomfort] 但被忽略 → 只问皮肤问题。
- **新流程**：primaryDomain = skin_mild，secondaryDomains = [general_discomfort]，domainWeights = { skin_mild: 0.6, general_discomfort: 0.4 } → 风险核查同时问皮肤红旗信号 + 全身不适红旗信号 → 分析阶段同时考虑两个域的假设。

#### 4.2.2 鉴别诊断"先排除后确认"

针对"痘痘"案例：

- **阶段 A（ruleout）**：must_rule_out 方向如"严重内分泌疾病（如多囊卵巢综合征）" → 要求 LLM 输出排除性证据（如"无月经紊乱、无多毛、无体重快速增加"）或标记 `cannot_rule_out`。
- **阶段 B（confirm）**：主要方向如"寻常痤疮"、"接触性皮炎"、"熬夜相关的皮脂分泌增加" → 每个方向必须有 triggerImpact 分析（如"熬夜 → 皮脂分泌增加 → 加重痤疮"）。

#### 4.2.3 R0/R1 强制追问

当风险等级为 R0/R1 但 `requiredCoreFields` 缺失时（如皮肤域缺 duration/location），强制 ask_user 一次，避免信息不足直接进入分析。

---

## 5. 技术选型

### 5.1 保持不变的技术栈

| 类别 | 选型 | 理由 |
|------|------|------|
| 运行时 | Node.js + TypeScript | 现有代码库基础 |
| LLM 调用 | OpenAI SDK + 自定义 `LlmClient` 抽象 | 已封装 structured output，不引入框架 |
| Schema 校验 | zod v4 | 与 TypeScript 集成最佳，现有代码深度使用 |
| 状态管理 | CaseState + caseStateService 串行合并 | 已验证可靠，无需引入状态机框架 |
| 工具抽象 | `defineTool` + `ToolExecutor` | 已封装 guard / timeout / trace，无需替换 |
| 搜索 | Firecrawl + 自定义 SearchPipeline | 已实现并发 + 过滤 + 聚合 |

### 5.2 新增技术决策

| 类别 | 选型 | 理由 |
|------|------|------|
| 多域权重计算 | 触发词命中数 + 域优先级加权（纯代码） | 无需 LLM，确定性高 |
| 鉴别诊断两阶段 | 两次 LLM 调用（ruleout + confirm） | 比单次调用更可控，可在阶段 A 失败时降级为单阶段 |
| 排除性证据存储 | CaseState 新增 `ruleoutEvidence: Record<hypothesisName, { status, evidence }>` | 持久化排除结果，供 final_answer 门控检查 |
| 诱因影响存储 | Hypothesis 新增 `triggerImpact: Array<{ trigger, impact, evidenceRefs }>` | 结构化诱因分析，供报告渲染 |
| R0/R1 强制追问触发 | 代码检查 `requiredCoreFields` 缺失 | 确定性，不依赖 LLM 判断 |

### 5.3 明确不引入的技术

- **不引入 LangGraph / LangChain**：现有 `agentLoop` + `decideAction` 已实现等效控制流，引入框架增加抽象层无收益。
- **不引入状态机库**：`maxAgentSteps=7` 的有限步数下，switch-case 比状态机更可读。
- **不引入向量检索 / RAG**：当前 Firecrawl 联网搜索已满足证据需求，且医学证据需要可溯源 URL，向量检索反而降低可解释性。

---

## 6. 数据结构变更总览

### 6.1 CaseState 新增字段

```typescript
// server/agent/case/CaseState.ts

interface SymptomDomainState {
  primaryDomain: SymptomDomain
  secondaryDomains: SymptomDomain[]
  triggerTerms: string[]
  supportedDepth: 'full' | 'red_flag_only'
  reason: string
  // ★ 新增：多域权重，key 为 domain，value 为 0-1 归一化权重
  domainWeights?: Partial<Record<SymptomDomain, number>>
}

interface RiskProbeState {
  // ... 现有字段 ...
  // ★ 新增：按域分组的核查结果
  perDomainResults?: Array<{
    domain: SymptomDomain
    redFlagConfirmed: string[]
    redFlagDenied: string[]
    unresolvedRedFlags: string[]
  }>
}

interface CaseState {
  // ... 现有字段 ...
  // ★ 新增：排除性证据记录（鉴别诊断阶段 A 产出）
  ruleoutEvidence?: Array<{
    hypothesisName: string
    status: 'ruled_out' | 'cannot_rule_out' | 'inconclusive'
    evidence: string[]
    evidenceRefs: string[]
    reason: string
  }>
}
```

### 6.2 Hypothesis 新增字段

```typescript
// server/agent/analysis/hypothesisSchema.ts

const hypothesisSchema = z.object({
  // ... 现有字段 ...
  // ★ 新增：该假设的排除状态（由阶段 A 填充）
  ruleoutStatus: z.enum(['ruled_out', 'cannot_rule_out', 'not_applicable', 'pending']).optional(),
  // ★ 新增：诱因影响分析
  triggerImpact: z.array(z.object({
    trigger: z.string(),
    impact: z.string(),
    evidenceRefs: z.array(z.string()),
  })).optional(),
})
```

### 6.3 CaseAnalyzeOutput 新增字段

```typescript
const caseAnalyzeOutputSchema = z.object({
  // ... 现有字段 ...
  // ★ 新增：两阶段标记
  analysisStage: z.enum(['ruleout', 'confirm', 'single']).optional(),
  // ★ 新增：是否所有 must_rule_out 已处理
  allRuleoutsResolved: z.boolean().optional(),
})
```

---

## 7. 与现有方案的对比分析

### 7.1 问题 → 根因 → 改进映射

| 用户反馈问题 | 代码根因 | 新方案改进 | 对应计划 |
|--------------|----------|------------|----------|
| 症状分析不全面（忽略身体紧绷） | `symptomDomainClassifier.ts` 只取主域，secondaryDomains 未被后续使用；`general_discomfort` 缺"紧绷"触发词 | 多域权重输出 + 后续阶段消费 secondaryDomains + 扩充触发词 | [001](./001-multi-domain-symptom-analysis.md) |
| 因果关系判断错误（痤疮 vs 痘痘） | `analyzeCase.prompt.ts` 未强制"先排除后确认"；`decideAction.ts` 未检查 must_rule_out 是否被处理 | 两阶段分析（ruleout → confirm）+ final_answer 门控 | [002](./002-differential-diagnosis-ruleout.md) [005](./005-canfinalanswer-gating.md) |
| 影响因素考虑不足（熬夜等） | `analyzeCase.prompt.ts` 未要求分析 triggers 对假设的影响 | Hypothesis 新增 triggerImpact 字段 + prompt 强制要求 | [003](./003-lifestyle-factors-analysis.md) |
| 诊断逻辑不严谨（缺"先排除后确认"） | `agentLoop.ts` 仅 R2 强制追问，R0/R1 信息缺失也可能直接分析；`decideAction.ts` 未使用 canFinalAnswer | R0/R1 强制追问分支 + canFinalAnswer 门控 | [004](./004-r0-r1-mandatory-followup.md) [005](./005-canfinalanswer-gating.md) |

### 7.2 改进前后对比（以"痘痘+身体紧绷"为例）

#### 改进前

```
用户：最近脸上长痘痘，而且感觉人身体紧绷

阶段 1 症状抽取：chiefComplaint="脸上长痘痘"，associatedSymptoms=["身体紧绷"]
阶段 2 域识别：primaryDomain=skin_mild（"痘痘"命中），secondaryDomains=[general_discomfort]（"紧绷"未命中触发词，实际为空）
阶段 3 风险核查：仅针对 skin_mild 问 3 个问题
阶段 4 红旗评估：R0
阶段 5 决策：analyze_case → 单次 LLM 分析 → hypotheses=[痤疮] → final_answer
报告：直接判定"痤疮"
```

#### 改进后

```
用户：最近脸上长痘痘，而且感觉人身体紧绷

阶段 1 症状抽取：chiefComplaint="脸上长痘痘"，associatedSymptoms=["身体紧绷"]，triggers=["熬夜"?]（如用户提及）
阶段 2 域识别：primaryDomain=skin_mild，secondaryDomains=[general_discomfort]（"紧绷"命中扩充后的触发词）
                domainWeights={ skin_mild: 0.6, general_discomfort: 0.4 }
阶段 3 风险核查：对 skin_mild + general_discomfort 各自执行 riskProbe，合并结果
阶段 4 红旗评估：R0，但 requiredCoreFields 缺失（duration/location）→ 强制 ask_user 一次
阶段 5 决策：
  - ask_user（追问病程、部位、是否熬夜/压力大）
  - analyze_case 阶段 A（ruleout）：must_rule_out=[严重内分泌疾病] → 输出排除性证据
  - search_medical（按多域检索）
  - analyze_case 阶段 B（confirm）：hypotheses=[寻常痤疮, 接触性皮炎, 熬夜相关皮脂分泌增加]
    每个方向有 triggerImpact 分析
  - generate_care_plan
  - final_answer（门控检查：canFinalAnswer + allRuleoutsResolved）
报告：1-3 个疑似方向 + 排除说明 + 诱因影响 + 处理建议
```

---

## 8. 实施步骤总览

详细实施步骤见各子计划：

1. **[001] 多域症状分析**：重构 `symptomDomainClassifier.ts` + 扩充 `symptomDomainConfig.ts` 触发词 + `CaseState` 新增 `domainWeights` + `riskProbe` 支持多域。
2. **[004] R0/R1 强制追问**：`agentLoop.ts` 在阶段 4 后增加 R0/R1 信息缺失检查分支。
3. **[002] 鉴别诊断"先排除后确认"**：`caseAnalyzer.ts` 重构为两阶段 + `analyzeCase.prompt.ts` 重写 + `hypothesisSchema.ts` 新增字段。
4. **[003] 生活方式影响因素**：`analyzeCase.prompt.ts` 要求 triggerImpact + `Hypothesis` 新增字段。
5. **[005] canFinalAnswer 门控**：`decideAction.ts` 检查 canFinalAnswer + ruleoutStatus。

每个子计划包含：当前代码摘录、目标代码示例、修改步骤、验证命令、测试计划、回滚策略。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 两阶段分析增加 LLM 调用次数（成本 + 延迟） | 阶段 A 失败时降级为单阶段；`maxAgentSteps` 保持 7，通过 `nextDecisionDeterministic` 跳过冗余决策 |
| 多域核查增加追问数量，用户体验下降 | 复用现有 `maxQuestionsPerTurn` 限制（首轮 3 个，之后 1 个）；按域权重排序只问最关键的 |
| Hypothesis 新增字段破坏现有报告渲染 | 新字段全部 optional，报告渲染器向后兼容；`finalAnswerGuard` 不依赖新字段 |
| R0/R1 强制追问可能导致循环 | 复用 `maxAskedQuestionsTotal=8` 兜底；强制追问只触发一次（用 `meta.followupRounds` 判断） |

---

## 10. 验收标准

新版 agent 必须通过以下场景验收：

1. **痘痘+身体紧绷场景**：输出至少 2 个疑似方向（非单一"痤疮"），包含 must_rule_out 排除说明，包含熬夜等诱因影响分析。
2. **单一明确症状场景**（如"嗓子疼 3 天，无发烧"）：不因多域改动而过度追问，保持原有流畅度。
3. **急症场景**（如"胸痛伴冷汗"）：R3 直出不受影响。
4. **信息不足场景**（如"不舒服"）：R0/R1 强制追问触发一次，补充信息后再分析。
5. **所有现有测试通过**：`npm run test:agent` 绿色。
