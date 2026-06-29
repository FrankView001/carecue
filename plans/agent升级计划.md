# CareCue 4.0 设计文档

> 本文档是 CareCue 改版的总纲。所有后续编码任务以本文档为准。 模块级详细文档（Workspace、各工具、Guard 等）在动手实现该模块前单独撰写。

------

## 第一部分：产品需求

### 1.1 产品定位

CareCue 是面向普通用户的家用健康咨询助手。用户用自然语言描述身体不适，CareCue 像有经验的家庭医生一样：先排查危险信号，再针对性追问，最后给出非确诊性的护理建议或就医提示。

**核心承诺**：

- 不下确诊结论
- 不给具体药物剂量
- 危险信号 100% 召回
- 对话自然，不像填表

### 1.2 目标用户与场景

- 主要场景：轻症自查、是否需要就医的判断、护理建议
- 不覆盖：复诊管理、慢病管理、心理咨询、儿科急症
- 用户特征：成年人，无医学背景，期待被引导

### 1.3 用户体验目标

| 指标           | 目标    |
| -------------- | ------- |
| 单轮响应时间   | < 8 秒  |
| 一次咨询总时长 | < 90 秒 |
| 平均轮数       | 3-6 轮  |
| 急症识别召回率 | ≥ 95%   |
| 用户中途流失率 | < 20%   |

### 1.4 范围边界

**做**：

- 症状鉴别（皮肤、消化、呼吸、轻度神经类）
- 红旗筛查与急症建议
- 护理建议（非处方、生活方式）
- 就医建议（科室、紧迫程度）

**不做**：

- 处方与剂量
- 检验报告解读
- 心理咨询
- 儿童 / 孕妇专科（V1 不覆盖，未来扩展）

------

## 第二部分：技术架构

### 2.1 核心范式

**约束式事件循环**（Constrained Event Loop）

```
while not done:
    1. 读取共享 Workspace
    2. 执行硬约束检查（必须做的事还没做？）
    3. 模型决策下一步动作
    4. Guard 检查动作是否合规
    5. 执行工具
    6. 工具结果写回 Workspace
    7. 判断是否收尾（由模型自己判断）
```

不是状态机。没有预设的"第几步"。模型每轮独立决策，约束由 Guard 兜底。

### 2.2 系统组成

四个核心组件：

```
┌─────────────────────────────────────────────┐
│              主循环 AgentLoop                │
│   决策 → Guard → 工具调用 → 写回上下文       │
└───────────┬─────────────────────┬───────────┘
            │                     │
            ▼                     ▼
    ┌──────────────┐      ┌──────────────┐
    │   Workspace   │      │  Tool Box    │
    │   共享状态    │      │   工具箱     │
    └──────────────┘      └──────┬───────┘
                                  │
                                  ▼
                          ┌──────────────┐
                          │ Knowledge KB │
                          │  本地知识库  │
                          └──────────────┘

         全局拦截：Guard / Hooks
```

**物理位置**（后端目录结构）：

**注意事项**：充分考虑当前代码库、删除不合理的部分；

```
server/
├── src/
│   ├── agent/
│   │   ├── loop.ts            # 主循环
│   │   ├── workspace.ts        # Workspace 类
│   │   ├── guard.ts            # Guard 拦截器
│   │   └── llm.ts              # DeepSeek/OpenRouter 封装
│   ├── tools/
│   │   ├── index.ts            # 工具注册表
│   │   ├── lookupRedFlags.ts
│   │   ├── askUser.ts
│   │   ├── updateRedFlag.ts
│   │   ├── addHypothesis.ts
│   │   ├── searchMedical.ts    # Firecrawl 实现
│   │   └── generateReport.ts
│   ├── knowledge/
│   │   ├── loader.ts           # 启动时加载 YAML
│   │   └── files/              # 实际 YAML 文件
│   │       ├── red_flags.yaml
│   │       ├── hypothesis_hints.yaml
│   │       ├── care_plans.yaml
│   │       └── referral_rules.yaml
│   ├── schemas/                # Zod schema 定义
│   ├── routes/                 # Express 路由
│   │   └── consult.ts          # POST /api/consult
│   └── db/                     # Prisma client 封装
└── prisma/
    └── schema.prisma           # Workspace / Trace 模型
```

前端 `client/` 保持现有 React 19 + Vite 结构，仅替换调用后端的接口。

### 2.3 Workspace 设计

共享工作区，所有工具读写它，所有决策基于它。

**存储**：内存运行 + PostgreSQL 持久化（每轮 upsert 一次）

- 内存对象供主循环高速读写
- PG 中以 JSONB 存储，方便重放、debug、长会话恢复
- 对应 Prisma model：`Workspace`

**字段**：

```typescript
interface Workspace {
  // 基础信息
  age?: number
  sex?: 'male' | 'female'
  
  // 症状
  symptoms: string[]              // 用户描述的原始症状
  extractedFacts: Record<string, any>  // 结构化字段（持续时间、诱因等）
  
  // 红旗
  redFlags: {
    name: string
    status: 'pending' | 'ruled_out' | 'positive'
    evidence?: string
  }[]
  
  // 假设
  hypotheses: {
    name: string
    weight: number               // 0-1
    supportingEvidence: string[]
    againstEvidence: string[]
  }[]
  
  // 对话历史
  askedQuestions: string[]       // 防重问
  rounds: number
  
  // 检索缓存
  searchResults: Record<string, any>
}
```

**核心方法**：

- 增量更新（addSymptom、addHypothesis 等），不允许整体替换
- toSummary() 生成给 LLM 看的紧凑描述（不直接把完整对象塞 prompt）

### 2.4 工具箱设计

工具是原子的、独立的、可单独测试的。

**V1 工具清单**：

| 工具名            | 职责                        | 输入                   | 输出                        |
| ----------------- | --------------------------- | ---------------------- | --------------------------- |
| extract_facts     | 从自然语言抽取结构化信息    | text                   | { age, sex, symptoms, ... } |
| lookup_red_flags  | 检索本地红旗知识库          | symptoms[]             | RedFlag[]                   |
| ask_user          | 向用户追问一个问题          | question, target       | (中断循环，等用户回复)      |
| update_red_flag   | 标记红旗状态                | name, status, evidence | void                        |
| add_hypothesis    | 添加一个鉴别假设            | name, initialEvidence  | void                        |
| update_hypothesis | 更新假设权重                | name, evidence, delta  | void                        |
| search_medical    | 联网查权威资料（Firecrawl） | query                  | { snippets, sources }       |
| generate_report   | 生成最终报告                | (从 workspace 读)      | string                      |

**工具设计原则**：

1. 单一职责。一个工具只干一件事。
2. Schema 小。一个工具的 input schema 不超过 5 个字段。
3. 幂等。同样输入同样输出。
4. 不互相调用。工具之间不直接依赖，由主循环编排。

### 2.5 知识库设计

本地 YAML 文件，按症状索引。

**文件结构**：

```
knowledge/
├── red_flags.yaml         # 症状 → 红旗映射
├── hypothesis_hints.yaml  # 症状 → 候选假设
├── care_plans.yaml        # 假设 → 护理建议
└── referral_rules.yaml    # 状态 → 就医建议
```

**red_flags.yaml 示例**：

```yaml
- symptoms: [头晕, 胸闷]
  red_flags:
    - name: 心源性
      ask: 有没有压榨性疼痛？是否放射到左臂？
      positive_signals: [压榨痛, 放射痛, 冷汗]
    - name: 脑血管
      ask: 有没有一侧手脚无力、说话不清？
      positive_signals: [偏瘫, 言语障碍, 视野缺损]
```

**维护原则**：

- 由产品/医学顾问维护，开发不直接动
- 每条目必须有 ask 字段（区分用问题）
- 不写诊断标准，只写区分线索

### 2.6 Guard 设计

常驻拦截器。每次工具调用前后执行。

**V1 规则**：

1. 症状非空但红旗未加载 → 强制 lookup_red_flags
2. 有 pending 红旗 → 禁止 generate_report
3. 重复问题 → 拒绝 ask_user，要求换问法
4. 报告中出现"确诊""一定是""必须服用 X mg" → 拦截重写
5. 检测到高危红旗 positive → 强制生成急症提示

**接口**：

```typescript
function guard(action: ToolCall, ws: Workspace): 
  { allow: true } | { allow: false, reason: string, suggest?: ToolCall }
```

拒绝时把 reason 反馈给 LLM，让它重新决策。不是直接抛错。

### 2.7 LLM 调用与回退

**主路径**：DeepSeek 官方 API（deepseek-chat 模型，OpenAI 兼容 tool calling）

**LLM 级回退**：OpenRouter

- 仅在 DeepSeek API 整体不可用时触发（连续 3 次连接失败 / 503）
- 切换后整个会话保持在 OpenRouter，不来回切
- 这是**基础设施级别**的回退，不是**业务逻辑级别**的回退

**工具失败重试策略**（与 LLM 回退区分清楚）：

- 单次工具调用失败 → 重试 1 次
- 重试仍失败 → 把错误信息作为工具结果返回给 LLM，让它换工具/换方法
- **不设计"DeepSeek → OpenRouter → 本地规则"这种串行降级链**。这是状态机思维，与本架构相悖。

**Token 管理**：

- Workspace 不直接塞 prompt，用 toSummary() 压缩
- 工具结果超 500 token 自动摘要
- 单次对话总 token > 20k 时触发压缩
- Zod schema 描述精简，不写长 description

**Schema 强约束**：

- 所有工具入参用 Zod 定义并校验
- 所有工具出参用 Zod 定义并校验
- LLM 返回的 tool_use.input 用 Zod parse，失败则要求 LLM 重新调用

### 2.8 可观测性

每次工具调用记录：

- 时间戳、工具名、输入、输出、耗时
- LLM 调用的 provider（deepseek/openrouter）、model、tokens、duration、The full content of the request-response
- Guard 拦截事件
- Workspace 快照（每轮一份）

**存储**：PostgreSQL（与现有 Prisma schema 对齐）

- `traces` 表：每次工具调用 / LLM 调用一行
- `workspaces` 表：每个会话一行，包含每轮快照（JSONB）

**前端可视化**（V2，V1 不做）：

- 单独 debug 页面，展示某次会话的完整 trace
- 时间轴 + 工具调用瀑布图

------

## 第三部分：实施路径

### 3.1 里程碑

**M1：骨架打通（目标：1 周）**

- 知识库 1 组症状（头晕+胸闷）
- 工具：lookup_red_flags、ask_user、update_red_flag、generate_report
- 主循环 + Mock LLM
- 端到端跑通"头晕胸闷"案例

**M2：接入真实 LLM（目标：1 周）**

- DeepSeek 接入
- Guard V1（前 3 条规则）
- Workspace 完整实现
- 端到端测试 3 个真实症状

**M3：扩展能力（目标：2 周）**

- 知识库扩到 10 组症状
- 工具补全（extract_facts、search_medical 接入 Firecrawl、hypothesis 系列）
- Guard 全部 5 条规则
- 可观测性日志落 PG

**M4：用户测试（目标：1 周）**

- 真实用户测试 20 例
- 性能优化（响应时间、token 用量）
- Bug 修复

### 3.2 每个模块的实施流程

```
1. 写模块文档（1-2 页，详见模板）【命名规范：001-工具箱的设计】
2. 基于文档，生成代码
3. 跑测试，验证
4. 通过 → 下一模块；不通过 → 修文档（不是修代码）
5. 再次执行2-5，直至测试通过；
```

### 3.3 模块文档模板

每个模块在动手前写一份，包含：

```markdown
## 模块：[名称]

### 职责
一句话说清这个模块干什么。

### 输入输出
- 输入：类型、字段、含义
- 输出：类型、字段、含义

### 依赖
- 依赖哪些其他模块
- 依赖哪些外部库

### 核心逻辑
3-5 步说清楚

### 测试用例(Few Shot)
- 至少 3 个，包含正常 + 边界
- 文字阐述+代码接口

### 不做什么
明确边界，防止 AI 过度发挥
```

### 3.4 任务派发规则

- 一次只派一个模块给 AI
- AI 输出的代码 100% 检查测试用例是否通过
- 不通过：分析是文档没说清还是 AI 写错。文档没说清 → 补文档。AI 写错 → 在 prompt 里加更具体的约束。
- 通过：下一模块，写一句话记录这个模块完成

------

## 第四部分：边界与约束

### 4.1 本期不做的事

- 不做 RAG（V1 知识库够用）
- 不做向量数据库
- 不做多模态（图片识别）
- 不做语音
- 不做用户账号系统（沿用现有 carecue 的，若有）
- 不做付费功能
- 不做 trace 可视化前端页面
- 不重写现有前端，仅替换后端 agent 部分

### 4.2 技术栈（与现有 carecue 项目对齐）

**前端**

- React 19 + TypeScript + Vite
- Lucide React（图标）

**后端**

- Node.js + Express 5.x
- TSX（开发态运行 TypeScript）
- Zod（Schema 校验，工具入参出参强约束）

**数据库**

- PostgreSQL 17 + Prisma ORM 7
- Workspace、Trace、知识库索引都落库

**AI / 检索**

- DeepSeek 官方 API（LLM 主路径，tool calling）
- OpenRouter（LLM 回退路径，仅在 DeepSeek 不可用时启用，**不在工具失败时回退** —— 见 2.7）
- Firecrawl（联网核查，作为 search_medical 工具的底层实现）

**知识库**

- YAML 文件（红旗、护理建议等静态知识）放 `knowledge/` 目录
- 文件内容启动时加载到内存，需要时再做 PG 索引

**测试**

- vitest

**部署**

- Docker + Docker Compose

**包管理**

- npm（与现有项目一致）

**锁定理由**：100% 与现有 carecue 项目一致，零学习成本，零迁移成本。

### 4.3 不允许的设计

- 不允许在 prompt 里堆叠完整对话历史
- 不允许 LLM 一次返回超过 5 个字段的结构化输出
- 不允许工具之间直接调用
- 不允许在主循环里写 if/else 分支判断"现在该做什么"
- 不允许重新引入 domain.classify、symptom.extract 这种预设阶段

------

## 第五部分：成功标准

完成的判断标准（不是"感觉做完了"，是这些都能通过）：

1. 端到端跑通 5 个真实案例，每个都给出合理报告
2. 任一工具失败 1 次，对话仍能继续
3. 高危红旗用例 100% 触发急症提示
4. 单次咨询 LLM 总调用 ≤ 8 次
5. 平均响应时间 ≤ 8 秒/轮

