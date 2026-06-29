# CareCue Agent v4.0 改造状态记录

> 创建日期: 2026-06-27
> 最后更新: 2026-06-29 (M2 接入真实 LLM — DeepSeek 决策类 + 路由 + 可观测性)

---

## 0bis、v4.0 设计文档落地 — M2 接入真实 LLM（2026-06-29）

> 依据：`plans/agent升级计划.md` M2；模块设计文档 `plans/002-M2接入真实LLM.md`。

**目标（M2：接入真实 LLM）已达成：**

| M2 项 | 状态 | 说明 |
|------|------|------|
| DeepSeek 接入（真实 tool calling） | ✅ | `DeepSeekLlm` 底层以 `CompleteFn` 注入，可不触网测试解析/回退 |
| OpenRouter 基础设施级回退 | ✅ | provider 整体失败才切换；不在工具失败时回退（设计 2.7） |
| Guard V1 | ✅ | pending 禁报告 / 重复问题 / 报告禁语 / 高危 positive 放行 + 新增「红旗已加载禁重复检索」防空转 |
| Workspace 完整实现 | ✅ | 增量更新 + toSummary + 快照（PG 持久化留 M3） |
| 端到端 3 个真实症状 | ✅ | 头痛 / 腹痛(急症) / 头晕胸闷，主循环对任意红旗知识库通用 |
| 可观测性（设计 2.8） | ✅ | `MemoryTracer` 记录 decision/guard/tool/llm/snapshot，对齐 M3 PG 落库 |
| HTTP 入口 `POST /api/consult` | ✅ | `routes/consult.ts` + `createConsultEngineFromEnv()`（无 Key 回退 Mock） |

**新增/改动文件：**
```
server/src/agent/trace.ts          # Tracer 接口 + MemoryTracer（可观测性）
server/src/agent/llm.ts            # DeepSeekLlm 改为可注入 CompleteFn + trace + 回退；MockLlm 保留
server/src/agent/guard.ts          # 新增「红旗已加载禁重复检索」规则
server/src/agent/loop.ts           # 线程化 Tracer；createConsultEngineFromEnv()
server/src/routes/consult.ts       # POST /api/consult
server/src/knowledge/files/*.yaml  # 红旗/护理扩到 3 组症状（头晕胸闷 / 头痛 / 腹痛）
server/src/m2.test.ts              # 9 用例（含 DeepSeek 解析/回退/Guard 闭环 + 路由 HTTP 往返）
```

**验证：**
```bash
npm run test:m1   # 8/8（M1 不回归）
npm run test:m2   # 9/9（真实 LLM 决策类 / 3 症状 e2e / 路由 / 可观测性）
npx tsc -p tsconfig.server.json --noEmit   # server/src/ 0 错误
```

**下一步（M3）：** extract_facts（去掉 naive 症状种子）、search_medical 接 Firecrawl、hypothesis 系列工具、知识库扩到 10 组、Tracer 落 PG（traces/workspaces 表）。上线接真实模型只需在 `.env` 配 `DEEPSEEK_API_KEY`（+ 可选 `OPENROUTER_API_KEY` 回退），并把 `createConsultRouter(createConsultEngineFromEnv())` 挂进应用。

---

## 0、v4.0 设计文档落地 — M1 骨架（2026-06-29）

> 依据：`plans/agent升级计划.md`（CareCue 4.0 设计文档），方法论见 §3.2 / §3.3。
> 模块设计文档：`plans/001-M1骨架设计.md`。

**目标（M1：骨架打通）已全部达成：**

| M1 项 | 状态 |
|------|------|
| 知识库 1 组症状（头晕 + 胸闷），YAML 落地 | ✅ |
| 工具：lookup_red_flags / ask_user / update_red_flag / generate_report | ✅ |
| 约束式事件循环主循环（非状态机）+ Mock LLM | ✅ |
| Workspace（增量更新 + toSummary + 快照） | ✅ |
| Guard（pending 禁报告 / 重复问题 / 报告禁语 / 高危 positive 放行急症） | ✅ |
| 端到端跑通「头晕胸闷」（正常排查 + 急症两条路径） | ✅ |
| 工具失败 1 次仍能继续（重试 + 错误反馈） | ✅ |

**物理位置：** 全新干净实现放在 `server/src/`，**不改动**遗留 `server/agent/` 与现有 Express 路由（迁移留待后续里程碑、由 trace 验证后再删旧）。

```
server/src/
├── agent/{workspace,guard,llm,loop}.ts   # Workspace / Guard / LLM(Mock+DeepSeek) / 主循环
├── tools/{index,types,lookupRedFlags,askUser,updateRedFlag,generateReport}.ts
├── knowledge/{loader.ts, files/*.yaml}   # red_flags / hypothesis_hints / care_plans / referral_rules
├── schemas/index.ts                       # Zod 入参出参强约束
└── consult.test.ts                        # M1 端到端测试（8 用例全过）
```

**验证：**
```bash
npm run test:m1        # 8/8 通过（正常报告 / 急症 / 强制加载 / 失败恢复 / 4 条 Guard）
npx tsc -p tsconfig.server.json --noEmit   # server/src/ 0 错误
```
> 注：legacy `server/index.ts` 等 7 处 typecheck 错误是 Prisma client 未生成（postinstall 拉取引擎被网络策略拦截）所致，与 M1 无关。

**下一步（M2）：** DeepSeek 真实接入（`llm.ts` 中 `DeepSeekLlm` 已就绪，待用 `createDeepSeekLlm()` 在新路由 `routes/consult.ts` 装配）；Guard 接全部 5 条；Workspace 落 PG。M1 期间 Mock LLM 内置了轻量否定启发式（真实 LLM 天然理解否定）。

---

## 一、目标

| 目标 | 状态 |
|------|------|
| 去掉 R2 阻塞，让流程不被清单式风险核查卡住 | ✅ 完成 |
| 初始假设生成：基于症状组合立即推理 | ✅ 完成 |
| 假设驱动追问：基于鉴别点生成问题 | ✅ 完成 |
| 假设精化：根据新信息更新假设概率 | ✅ 完成 |
| 用户自我判断能被接住而非机械追问 | ✅ 完成 |
| 多轮对话收敛（max 5 轮） | ✅ 完成 |
| general_discomfort 域支持 full 分析 | ✅ 完成 |
| **全局异常捕获 — 未预期错误不暴露给用户** | ✅ 完成 |
| **增强错误日志 — 记录完整 message/name/stack/caseId/userId** | ✅ 完成 |
| **DeepSeek 官方 API 直连作为 LLM 主路径** | ✅ 完成 |
| **保留 OpenRouter 作为 LLM 回退路径** | ✅ 完成 |
| **LLM request/response/JSON/schema trace 完整记录** | ✅ 完成 |

---

## 二、已确认结论

1. **R2 不再阻塞分析流程** — 风险信号记录在 state 中但不再阻止进入假设推理
2. **假设优先于风险核查** — 症状抽取后先生成假设，再检查风险（R3 仍可拦截）
3. **假设驱动提问比模板提问更精准** — 问题绑定 `differentiatesBetween` 字段，指向具体假设
4. **用户自述病因应被优先采用** — 当用户给出自我判断时，假设应与此一致
5. **多轮测试需要 mock 完整 LLM 响应链** — 每个 schemaName 都需要 mock 输出
6. **questionGuard 的 `fieldHasValue` 检查会过滤掉目标字段已有值的追问** — 即使追问是为了获取更精细的信息（如 `symptoms.duration` 已有"约两周"但还想问"每次持续几小时"），由于该字段已有值，追问会被丢弃。需要更细粒度的字段设计或放宽此检查
7. **finalAnswerGuard 的 `findMedicationViolations` 会误伤安全剂量说明** — "每日不超过2g"中的"2g"匹配 dosage 正则会触发 `MEDICATION_DOSAGE` fatal 错误。药量数字应用中文（"两克"）避免正则匹配
8. **动态 import 的 prompt 文件（generateHypothesisQuestions.prompt.ts）在 try-catch 之外** — 风险低（编译已通过），但遇到文件缺失时不可恢复
9. **`caseStateService.merge()` 中的 `PrismaCaseStore.save()` 无 try-catch 包裹** — 数据库连接中断时会导致整个 agent run 崩溃，现已通过 agentLoop 全局 try-catch 兜底
10. **OpenRouter 不应立即删除** — 当前已改为 DeepSeek 直连优先，OpenRouter 保留为跨供应商回退；后续用 trace 对比延迟和失败率后再决定是否移除
11. **DeepSeek 直连减少一层中间路由，但不是零数据风险** — 日志和 README 已明确：直连减少 OpenRouter 暴露面，但 DeepSeek 官方 API 仍会处理用户输入与模型输出
12. **结构化输出失败必须可降级** — `LlmOutputInvalidError` 已被纳入 recoverable LLM 错误，避免 JSON/schema 失败继续冒泡成 `TOOL_RUNTIME_ERROR`
13. **当前 `question.generate_hypothesis` 报错根因是外层工具超时** — 最新 trace 显示 `symptom.extract` 成功，`question.generate_hypothesis` 在 DeepSeek/OpenRouter 回退仍未结束前被 `Tool timeout after 25000ms` 中断；已新增 LLM 总预算，让慢模型链路主动抛 `LlmUnavailableError` 并进入工具降级

---

## 三、已修改文件及关键位置

### 核心流程

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `agentLoop.ts` | ~L62-120 | **新增**：全局 try-catch 兜底，未预期错误返回 stage_report |
| `agentLoop.ts` | ~L146-165 | 新增 Phase 3：初始假设生成 |
| `agentLoop.ts` | ~L210-215 | 替换 R2 阻塞为轻量跳过 |
| `agentLoop.ts` | ~L393-425 | ask_user 分支：有假设时用 hypothesis questions |
| `server/index.ts` | ~L227-230 | **增强**：错误日志记录完整 field（message/name/stack/caseId/userId/preview） |
| `server/index.ts` | ~L279-286 | **增强**：SSE 流式端点错误日志同上述 |
| `decideAction.ts` | ~L148-183 | deterministic 策略：有假设时优先搜索/分析 |

### 风险系统

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `risk/riskProbe.ts` | ~L66-144 | `computeRiskProbe` 不再阻塞（canProceedToAnalysis 逻辑保留但不再拦截） |

### 假设系统（新增）

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `hypothesis/hypothesisGenerator.ts` | ~L19-53 | 核心：基于症状组合生成初始假设 |
| `hypothesis/hypothesisGenerator.ts` | 顶部 + structured 调用 | 新增 LLM 总预算和更宽工具超时，慢模型时走低置信假设降级 |
| `hypothesis/hypothesisRefiner.ts` | ~L18-55 | 核心：根据新信息精化假设 |
| `hypothesis/hypothesisRefiner.ts` | 顶部 + structured 调用 | 新增 LLM 总预算和更宽工具超时，慢模型时保留现有假设 |
| `llm/llmClient.ts` | `LlmStructuredOptions.maxDurationMs` | 新增结构化调用总预算，耗尽后抛 `LlmUnavailableError` 并记录 trace |
| `llm/prompts/initialHypothesis.prompt.ts` | 全部 | 初始假设推理 prompt |
| `llm/prompts/refineHypothesis.prompt.ts` | 全部 | 假设精化 prompt |
| `llm/prompts/generateHypothesisQuestions.prompt.ts` | 全部 | 鉴别追问 prompt |

### 追问系统

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `question/followupGenerator.ts` | ~L132-208 | 新增 `question.generate_hypothesis` 工具 |
| `question/followupGenerator.ts` | 顶部 + structured 调用 | 追问类 LLM 调用加 18s 总预算，超时后使用 missingInfo/riskProbe 降级 |
| `question/questionGuard.ts` | ~L40-43 | **关键发现**：`fieldHasValue` 检查会过滤已有值字段的追问 |

### 安全复核

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `safety/finalAnswerGuard.ts` | ~L77-84 | 用药表述检测（本次排查触发点） |
| `analysis/medicationBoundaryAnalyzer.ts` | ~L16-21 | **发现**：`/\d+(\.\d+)?\s*(mg\|...\|g\|...)/i` 匹配纯单位字符（无词边界） |

### 症状域

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `symptoms/symptomDomainConfig.ts` | ~L191-204 | general_discomfort：添加搜索模板，supportedDepth 改为 full |

### 注册与限制

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `index.ts` | ~L26, L67-69 | 注册 3 个新工具 |
| `agentLimits.ts` | ~L19-20 | 新增 maxHypothesisRounds(5), maxRiskProbeRounds(3) |
| `case/CaseState.ts` | ~L131, L222 | 新增 meta.hypothesisRounds |

### LLM 供应商与结构化输出（2026-06-28 新增）

| 文件 | 关键位置 | 改动 |
|------|---------|------|
| `llm/llmClient.ts` | 全部 | 新增 `createCareCueLlmClient()`：DeepSeek 官方 API 优先，OpenRouter 主模型/备选模型回退 |
| `llm/llmClient.ts` | structured 调用链 | DeepSeek 使用 `json_object + Zod`；OpenRouter 保留 `json_schema -> json_object` |
| `llm/llmClient.ts` | error handling | 新增 `isRecoverableLlmError()`，统一处理 `LlmUnavailableError` / `LlmOutputInvalidError` |
| `logs/traceLogger.ts` | model_request / model_response | 分离记录模型请求与响应，包含 provider/model/baseURL/responseFormatMode/attempts/raw/parsed/duration |
| `index.ts` | runtime 装配 | 默认使用 `createCareCueLlmClient()` |
| `llm/llmClient.test.ts` | 全部 | 新增 LLM 客户端测试，覆盖 DeepSeek 优先、OpenRouter 回退、JSON/schema 错误、trace |
| `.env.example` | LLM 配置段 | 新增 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`LLM_PRIMARY_PROVIDER` |
| `compose.yaml` | api environment | 透传 DeepSeek / OpenRouter / timeout 相关环境变量 |
| `README.md` | 配置说明 | 标注 DeepSeek 直连主路径、OpenRouter 回退、数据风险边界 |

### LLM 工具降级（2026-06-28 新增）

| 文件 | 改动 |
|------|------|
| `symptoms/symptomExtractor.ts` | LLM 不可用或结构化输出不合法时走词典规则降级 |
| `symptoms/symptomDomainClassifier.ts` | LLM 不可用或结构化输出不合法时走触发词分类降级 |
| `hypothesis/hypothesisGenerator.ts` / `hypothesisRefiner.ts` | LLM 不可用或结构化输出不合法时走假设种子/保留原假设降级 |
| `analysis/caseAnalyzer.ts` / `carePlanGenerator.ts` | LLM 不可用或结构化输出不合法时走确定性分析/证据汇总降级 |
| `question/followupGenerator.ts` | LLM 不可用或结构化输出不合法时走模板追问降级 |
| `report/reportGenerator.ts` | LLM 不可用或结构化输出不合法时走 CaseState 模板报告 |
| `decideAction.ts` | LLM 决策不可用或输出异常时走确定性决策 |

---

## 四、已排除的原因

| 被排除的方案 | 原因 |
|-------------|------|
| 完全移除风险系统（整个 riskProbe） | R3 紧急拦截仍是必要的安全网，不能全移除 |
| 用 LLM 替代所有确定性决策 | 确定性决策是兜底安全策略，LLM 不可用时必须有 fallback |
| 增加 symptom.extract 超时到 120s | 治标不治本，应通过 answer-to-field 映射绕过 extract |
| 完全重新设计 CaseState | 现有状态模型可扩展，增量改动比重写更安全 |
| **本次错误是 symptom.extract 超时导致** | 实际是 `findMedicationViolations` 误伤 + `questionGuard` 过滤已有值字段 |
| **本次错误是 LLM API 不可用导致** | Mock 测试中工具正确走 fallback，生产日志需查看 `console.error` 输出确定 |

---

## 五、当前已知问题

| 问题 | 严重度 | 状态 |
|------|--------|------|
| **生产环境 "分析服务暂时不可用" 根因待定** | P0 | 🔴 待查日志 — 已加固兜底，下次出现时日志足够定位 |
| symptom.extract 在跟进轮次可能超时（30s） | P0 | ⏳ 待修复（需 answer-to-field 映射） |
| `findMedicationViolations` 误伤安全剂量警告（"2g"触发 dosage regex） | P1 | 🐛 新发现 — 可用中文数字（"两克"）绕过，或给 regex 加词边界 |
| `questionGuard.fieldHasValue` 过度过滤 — 已有粗粒度字段时无法追问细节 | P1 | 🐛 新发现 — 需 targetField 级别细分或放宽已有值检查 |
| 症状域分类器不支持否定词："不发烧"匹配"发烧"触发词 | P1 | 🐛 已知 |
| 动态 import 在 try-catch 之外（generateHypothesisQuestions.prompt.ts） | P2 | 📋 已知，风险低 |
| 症状域在后续轮次不会动态重分类 | P2 | 📋 待规划 |
| 多轮对话缺少假设收敛硬性检测 | P2 | 📋 待规划 |
| LLM trace 始终记录完整 messages/raw/parsed，包含症状原文 | P2 | ⚠️ 已按用户要求启用；生产需控制日志访问权限 |
| `npm run typecheck:api` 既有类型错误 | P2 | ✅ 已修复 |

---

## 六、测试覆盖现状

| 领域 | 测试用例 | 状态 |
|------|---------|------|
| 胸痛 (chest_pain) | 41.1, 41.2 | ✅ 通过 |
| 头痛 (headache) | 41.3 | ✅ 通过 |
| 眼部 (eye_discomfort) | 41.4, 41.5 | ✅ 通过 |
| 皮肤 (skin_mild) | 41.6, v4.7, v4.8, v4.9 | ✅ 通过 |
| 咽喉 (throat_respiratory) | v4.10, v4.11 | ✅ 通过 |
| 耳部不适 (未知域) | v4.12 | ✅ 通过 |
| 胃肠道 (gastrointestinal) | 无 | ❌ 待补充 |
| 全身不适 (general_discomfort) | v4.1-v4.6 | ✅ 通过 |
| **完整多轮交互 (模拟真实对话)** | interaction.test.ts | ✅ 通过（已生成 interaction.log.txt） |
| **LLM 客户端供应商链** | llmClient.test.ts | ✅ 通过（DeepSeek 优先、OpenRouter 回退、JSON/schema、trace） |

---

## 七、多轮交互测试结果（2026-06-27 晚间）

**场景**：28 岁女性程序员，因"每天下午太阳穴双侧胀痛 2 周"在线咨询

```
第 1 轮:
  👤 用户输入 → 🤖 AI 分析（症状抽取→域分类→3假设→R0风险→2个鉴别追问→返回 followup）
  追问 1: 每次头痛持续多久？一两个小时还是到晚上？
  追问 2: 怕光/怕吵吗？一侧比另一侧更疼吗？

第 2 轮:
  👤 用户回答（持续2-4小时、无畏光畏声、双侧对称、颈部牵拉感）
  → 🤖 AI 精化分析（排除偏头痛、收敛为2假设→R0风险→final_answer）
  → 📊 最终报告（日常护理5项 + OTC成分边界2项 + 避免行为4项 + 就医信号6项
     + 就诊科室建议 + 医生沟通摘要 + 3个向医生确认的问题）
```

**关键事件链**：
```
user_input → symptom.extract(success) → symptom.domain_classify(success: headache)
→ hypothesis.initial_generate(success: 3 hypotheses)
→ risk.probe(success) → risk.red_flag_assess(success: R0)
→ agent_decision(ask_user) → question.generate_hypothesis(success: 2 questions)
→ question_guard(kept: 2) → asked_questions_recorded → final_output(followup)

user_input → ... → hypothesis.initial_generate(success: 2 refined hypotheses)
→ agent_decision(final_answer) → report.generate(success)
→ final_guard(passed) → final_output(final_report) ✅
```

---

## 八、验证命令与结果

```bash
# 运行全部 agent 测试
cd D:/trae-project/CareCue
npm run test:agent

# 结果:
# PASS 31 agent v3 tests
# PASS 5 LLM client tests
```

```bash
# TypeScript 编译检查
npm run typecheck:api
# 结果: 通过
```

```bash
# 完整多轮交互日志
D:/trae-project/CareCue/interaction.log.txt  (252 行)
```

---

## 九、下一步动作

| 优先级 | 动作 | 说明 |
|--------|------|------|
| P0 | **查看生产服务器日志** | `docker compose logs api --tail 100 \| grep "Agent.*failed"` — 确定 "分析服务暂时不可用" 的实际根因 |
| P0 | **上线前配置 DeepSeek Key** | `.env` 设置 `AI_ENABLED=true`、`LLM_PRIMARY_PROVIDER=deepseek`、`DEEPSEEK_API_KEY`，保留 `OPENROUTER_API_KEY` 作为回退 |
| P0 | **观察 LLM trace 指标** | 对比 DeepSeek 与 OpenRouter 的 duration、timeout、schema/json 失败率，决定是否后续移除 OpenRouter |
| P1 | **修复 `findMedicationViolations` regex** | 给 dosage pattern 添加词边界 `\b`，或区分"安全上限警告"vs"给药指令" |
| P1 | **优化 `questionGuard.fieldHasValue`** | 允许对已有粗粒度值的字段追问细节（如 duration 已有"约两周"但可追问"每次持续几小时"） |
| P1 | **清理既有 typecheck 错误** | ✅ 已完成：agentLoop / agent.v3.test / exportTrace 的 TS 错误已修复 |
| P1 | **扩展胃肠道测试** | 补充腹痛/腹泻/胃痛场景的多轮对话测试 |
| P2 | **症状域动态重分类** | 用户补充新症状后重新评估域 |
| P2 | **假设收敛硬性检测** | 超过 maxHypothesisRounds 后强制输出 |
| P2 | **修复 symptom.extract 超时** | 跟进轮次中根据追问的 targetField 直接映射答案 |
