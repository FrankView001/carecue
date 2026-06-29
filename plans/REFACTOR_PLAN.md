# CareCue Agent 改造方案：从「清单核查驱动」到「假设驱动多轮推理」

## 问题诊断

当前系统核心问题是：**没有在「思考」，只是在跑流程。**

```
当前流程:
  symptom.extract → domain.classify → riskProbe(阻塞式) → 卡住

风险核查变成了逃避思考的借口:
  - 只要字段没填 → 追问 → 用户回答 → extract超时 → 状态不更新 → 永远追问
  - 系统从未问过自己"这组症状组合代表什么"
```

## 改造目标

| 现状 | 目标 |
|------|------|
| 机械检查必填字段 → 阻塞追问 | 收到症状后立即生成假设 → 针对性追问 |
| 追问模板化、无差异 | 追问基于当前假设、有鉴别目的 |
| 搜索需先通过风险核查 | 假设生成后即可搜索验证 |
| 状态因 extract 超时而卡死 | 双路径更新（LLM extract + answer-to-field） |
| 无收敛判断、可能死循环 | 假设稳定性检测 → 提前退出 |

## 新流程设计

```
Phase 1: 症状抽取 (不变)
  symptom.extract → symptom.domain_classify

Phase 2: 初始假设生成 (NEW)
  hypothesis.initial_generate
  基于 症状组合+诱因+缓解因素 → 生成 3~5 个假设 + 鉴别要点

Phase 3: 安全筛查 (轻量，不阻塞)
  risk.screen (只检 R3 紧急信号)
  R3 → emergency_stop
  非 R3 → 直接进入推理循环

Phase 4: 假设驱动推理循环 (NEW)
  Loop (max 5 轮, 收敛提前退出):
    decide_action:
      - ask_user → 基于假设生成追问 → answer-to-field 映射 → refine_hypotheses
      - search   → 基于假设搜索   → extract_evidence → refine_hypotheses
      - analyze  → 精化假设 (新信息评估)
      - final    → 结论收敛，输出
    收敛判断: most_likely 确认 + must_rule_out 排除 + 关键信息齐

Phase 5: 结论输出 (不变)
  report.generate → final_answer
```

## 分阶段实施

### 阶段 1: 解阻塞 + 初始假设 (✅ 已完成)
**核心改动:**
1. `riskProbe.ts` — 轻量化：只检 R3（晕厥、呼吸困难等），不再阻塞 R2
2. `agentLoop.ts` — 去掉 R2 阻塞门禁，加入初始假设生成步骤
3. 新建 `hypothesis/hypothesisGenerator.ts` — 基于症状组合的 LLM 推理
4. `agentLimits.ts` — 添加假设轮次上限 (maxHypothesisRounds=5, maxRiskProbeRounds=3)
5. `CaseState.ts` — 添加 meta.hypothesisRounds
6. `symptomDomainConfig.ts` — general_discomfort 域升级为 full（添加搜索模板）

**测试结果:** 22/22 PASS（含 3 个新增 Phase 1 专项测试）

### 阶段 2: 假设驱动追问 + 假设精化 (✅ 已完成)
**核心改动:**
1. 新建 `hypothesis/hypothesisRefiner.ts` — 假设精化工具
2. 新建 `llm/prompts/refineHypothesis.prompt.ts` — 精化 prompt
3. 新建 `llm/prompts/generateHypothesisQuestions.prompt.ts` — 鉴别追问 prompt
4. `followupGenerator.ts` — 新增基于假设的追问生成工具
5. `agentLoop.ts` — ask_user 分支根据假设存在与否选择不同追问策略
6. `index.ts` — 注册新工具

**测试结果:** 25/25 PASS（含 6 个新增测试用例）

### 阶段 3: 测试与体验优化 (待开始)
- 问题去重改为 targetField 级别
- 症状域动态重分类（"胸口闷"触发 chest_pain 域）
- 多轮对话测试用例扩展

## 测试策略

所有阶段使用 mock 数据测试:
- **mock LLM:** 按 schemaName 返回固定输出
- **mock Search:** 返回固定来源页面
- **多轮模拟:** 对同一 caseId 多次调用 runtime.run() 模拟对话
- **预编写用户回答:** 测试中直接 hardcode 模拟用户的追问回答

```
示例:
  runtime.run({ userMessage: "头晕、胸口有点闷" })
  // → 期望: 生成假设 + 追问
  
  runtime.run({ caseId, userMessage: "工作累了就会，休息就好" })
  // → 期望: 更新假设 + 搜索或分析
  
  runtime.run({ caseId, userMessage: "没有气短心慌" })
  // → 期望: 排除高危方向 + 结论收敛 + 输出报告
```
