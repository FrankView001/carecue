# CareCue Agent 改进计划索引

本目录由 `/improve` skill 生成，基于用户案例的"症状分析与诊断流程逻辑缺陷"（痘痘+身体紧绷案例）设计新版 agent 方案并形成可执行修改清单。

- **审计基线 commit**：`b6918d7`（HEAD at audit time）
  - 注：审计时实际 HEAD 为 `b6918d7`，该 commit 仅涉及 `promo/index.html`，不改动 `server/agent/` 任何代码，因此基于 agent 模块的审计结论与 `1628ad2` 一致。
- **审计范围**：`server/agent/` 全模块（症状抽取、域识别、风险核查、决策、分析、追问、报告、安全守卫）
- **未审计**：前端 `src/`、Prisma schema、auth、dify chatflow 迁移文件

## 新版 Agent 设计方案

详见 [000-new-agent-design.md](./000-new-agent-design.md) — 包含架构设计、功能模块划分、交互流程设计、技术选型。

## 修改清单与实施步骤（按依赖顺序）

| # | 计划 | 优先级 | 影响 | 工作量 | 依赖 | 状态 |
|---|------|--------|------|--------|------|------|
| 001 | [多域症状分析：消除"主域独占"](./001-multi-domain-symptom-analysis.md) | P0 | 高 | M | — | TODO |
| 002 | [鉴别诊断"先排除后确认"流程](./002-differential-diagnosis-ruleout.md) | P0 | 高 | L | 001 | TODO |
| 003 | [生活方式影响因素分析](./003-lifestyle-factors-analysis.md) | P1 | 中 | M | 001 | TODO |
| 004 | [R0/R1 关键信息缺失强制追问](./004-r0-r1-mandatory-followup.md) | P0 | 高 | M | 001 | TODO |
| 005 | [canFinalAnswer 门控与决策修正](./005-canfinalanswer-gating.md) | P0 | 高 | S | 002 | TODO |

## 依赖关系

```
001 (多域症状) ─┬─> 002 (先排除后确认) ─> 005 (canFinalAnswer 门控)
               ├─> 003 (生活方式因素)
               └─> 004 (R0/R1 强制追问)
```

**建议执行顺序**：001 → 004 → 002 → 003 → 005

001 是其他所有计划的基础（多域识别是后续分析、追问、决策的输入）。004 与 002 并行可行但建议先做 004（更小、风险更低）。005 必须在 002 之后，因为它依赖 `must_rule_out` 排除性证据字段。

## 验证基线

每个计划完成后必须通过的验证命令：

```powershell
npm run typecheck:api   # 类型检查
npm run lint            # ESLint
npm run test:agent      # Agent 集成测试（server/agent/agent.v3.test.ts）
```

如测试基线本身有问题，先修复测试再执行计划。

## 考虑并拒绝的发现

- **重写 agentLoop 为状态机框架**：当前 switch-case 结构清晰、步数有限（maxAgentSteps=7），引入状态机框架属于过度工程，拒绝。
- **替换 zod schema 为 JSON Schema + 运行时校验库**：zod 与 TypeScript 集成更好，现有代码已深度使用，拒绝。
- **引入 LangGraph/LangChain**：项目刻意保持 LLM 客户端抽象（`LlmClient`）轻量，引入框架会破坏现有 `defineTool` / `ToolExecutor` 抽象，拒绝。
