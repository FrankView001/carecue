# 问康 CareCue 技术设计文档

版本：v1.0
日期：2026-06-10
状态：Agent 链路核心代码结构已实现，待前端聊天界面完成对接。

## 1. 技术架构总览

```
React + TypeScript + Vite (前端)
  ↕ /api (REST)
Express + Prisma + PostgreSQL (后端)
  ↕
OpenRouter (DeepSeek 模型) + Firecrawl (权威检索)
```

| 层 | 技术选型 | 说明 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite + Tailwind CSS | 响应式，移动端优先 |
| 后端 | Node.js + Express | API 服务、鉴权、AI 网关 |
| 数据库 | PostgreSQL + Prisma ORM | 结构化 + JSON 字段，支持症状结构和结果快照 |
| AI 平台 | OpenRouter（DeepSeek 模型） | 统一模型调用，便于切换 |
| 检索引擎 | Firecrawl | 定向权威搜索，白名单约束 |
| 部署 | Nginx + Docker（后续） | 云服务器部署 |

## 2. Agent 工作流设计

### 2.1 总体链路

```
用户输入
  → AI 症状提取
  → 代码高危规则判断
  → 代码检查通用槽位
  → AI 动态判断关键信息缺口
  → AI 生成追问
  → 用户补充（循环，最多 1-3 轮）
  → AI 生成检索任务
  → 工具联网搜索（Firecrawl）
  → 代码来源过滤与证据评分
  → AI 最终建议生成
  → 代码安全拦截
  → 输出给用户
```

### 2.2 核心控制规则

```
信息不足 → 先追问，不搜索
命中高危 → 直接提醒就医，不猜病
信息基本足够 → 再联网核验
用户问药品 → 查说明书与权威来源，不开药
追问最多 1-3 轮
最终输出只给建议，不给确诊
```

### 2.3 状态机循环模型（Agentic Workflow）

后台不是一次性 API 调用，而是"分析 → 检索 → 验证 → 追问/总结"的多轮状态机：

```
[用户发送消息]
       │
       ▼
┌──────────────────────────────┐
│ 步骤1：AI 状态提取            │
│ 症状(S)、缺失(M)、搜索词(Q)   │
└──────────────┬───────────────┘
               │ (是否有新 Q?)
    [有] ──────┴────── [无/已搜过]
     │                      │
┌────▼────────────┐         │
│ 步骤2：Firecrawl │         │
│ 权威定向搜索     │         │
└────┬────────────┘         │
     │                      │
┌────▼──────────────────────▼──┐
│ 步骤3：AI 交叉验证            │
│ 症状对比、红旗拦截、信息充足度│
└────────────┬─────────────────┘
             │
 [信息不足] ─┴── [信息充足/红旗]
     │                    │
┌────▼──────┐    ┌────────▼──────┐
│ 步骤4A：   │    │ 步骤4B：      │
│ 生成追问   │    │ 生成最终报告  │
│ 及选项按钮 │    │ 含引用链接    │
└────────────┘    └───────────────┘
```

## 3. 环节设计：AI 驱动 vs 代码规则

### 3.1 需要 AI Prompt 的环节（4 个核心 + 1 个可选）

1. 症状结构化提取 Prompt
2. 追问问题生成 Prompt
3. 检索任务生成 Prompt
4. 最终建议生成 Prompt
5. 药品信息说明 Prompt（可选）

### 3.2 不需要 AI 的环节（代码/规则）

#### 3.2.1 高危判断（规则/代码）

高危判断必须写死规则，用于安全兜底。示例规则：

- 胸痛持续或加重
- 胸痛/胸闷 + 明显呼吸困难
- 头晕/头痛 + 单侧肢体无力/说话不清
- 突发剧烈头痛
- 眼痛 + 视力下降
- 剧烈腹痛或持续加重
- 高热不退或精神状态明显异常
- 大量出血
- 严重过敏反应
- 老人、孕妇、婴幼儿、严重基础病患者出现明显不适

**命中高危后：** 停止疾病推测、停止普通追问、直接输出及时线下就医提醒。

#### 3.2.2 通用槽位检查

共用一套基础槽位（不做全量症状配置表）：
谁不舒服、年龄、性别、哪里不舒服、什么时候开始、持续多久、严重程度、是否越来越重、有没有伴随症状、有没有明显诱因、以前是否出现过、有没有基础病、当前是否用药、用户最关心的问题。

#### 3.2.3 AI 动态缺口判断（受规则约束）

通用槽位 + 高危字段优先，症状细分字段由 AI 动态生成。每轮只问一个问题，最多追问 1-3 轮。

#### 3.2.4 来源白名单

后端配置。AI 只生成检索意图、医学关键词、查询目的。后端负责选择来源池、拼接 site 限定、过滤非白名单来源。

#### 3.2.5 搜索执行

工具调用。AI 不直接搜索，只告诉系统"要查什么"。

#### 3.2.6 证据评分

规则为主，AI 辅助。评分依据：来源等级、多来源一致性、症状匹配度、高风险建议、是否为权威医学资料。

#### 3.2.7 安全拦截

规则/后处理。禁止输出：确诊、排除严重疾病、推荐处方药、给药物剂量、保证没事、判断医生不可靠、鼓励用户对抗医生。

## 4. Prompt 设计

### 4.1 Prompt 1：症状结构化提取

**使用位置：** 用户首次输入或补充症状后。

**目标：** 把用户自然语言整理成结构化健康信息。

**Prompt 摘要：**
```
你是"问康"的症状信息提取助手。
你只做信息提取，不做诊断，不给建议，不推荐药品。

请提取：
- 就诊对象（本人/家人/不清楚）
- 年龄、性别、主要症状、症状部位
- 持续时间、发作方式（突然/逐渐/反复/不清楚）
- 严重程度（轻/中/重/不清楚）
- 诱因、伴随症状、已明确否认的信息
- 既往病史、当前用药、用户最关心的问题
- 仍缺失的基础信息、可能还需要确认的症状细节

输出格式：
一、已知信息
二、已否认信息
三、缺失的基础信息
四、可能还需要确认的症状细节
五、可能涉及的症状大类
六、用户当前意图

注意：
- "喘不上气"→呼吸困难，"快晕了"→接近晕厥
- "半边没力气"→单侧肢体无力，"说话含糊"→言语异常
- "眼睛磨得慌"→异物感，"脸上红疙瘩"→皮疹/丘疹/痘样损害
```

### 4.2 Prompt 2：追问问题生成

**使用位置：** 规则判断需要继续补充信息时。

**输入来源：** 已知信息、已否认信息、高危规则判断结果、通用槽位缺失情况、AI 动态识别的症状细节缺口、当前追问轮次。

**Prompt 摘要：**
```
你是"问康"的追问生成助手。

要求：
- 一次只问一个问题
- 优先确认高危信号
- 问题必须口语化，适合长辈理解
- 给出 2 到 4 个按钮选项
- 不要使用复杂医学术语
- 不要一次问多个并列问题
- 如果已经追问 3 轮，优先结束追问

追问优先级：高危信号 → 持续时间 → 是否加重 → 严重程度 → 伴随症状 → 诱因 → 既往病史 → 当前用药 → 症状细节

输出：
一、当前最关键缺失信息
二、为什么要问这个问题
三、给用户的问题
四、按钮选项
五、用户回答后应更新的字段
六、是否建议继续追问

示例风格：
"现在有没有明显喘不上气？" 选项：有 / 没有 / 不确定
"头痛是突然特别剧烈，还是慢慢出现的？" 选项：突然特别剧烈 / 慢慢出现 / 不确定
```

### 4.3 Prompt 3：检索任务生成

**使用位置：** 信息基本足够，需要联网核验时。

**禁止生成：** 确诊类搜索、处方药推荐搜索、偏方搜索、"能不能不去医院"类搜索、直接照抄用户原话。

**允许的检索意图：** 高危信号核验、可能疾病方向核验、轻重程度判断、日常处理建议、非处方药信息说明、就医边界核验、就医沟通建议。

每条检索任务包含：检索意图、医学关键词、推荐来源等级、查询目的、是否必须检索。

注意：不要自己拼接 site 限定词，信息源由后端根据来源白名单自动拼接。

### 4.4 Prompt 4：最终建议生成

**使用位置：** 联网核验完成后，或不需要搜索但已经可以给建议时。

**Prompt 摘要：**
```
你是"问康"的最终建议生成助手。

你不能确诊、不能排除严重疾病、不能推荐处方药、不能给药物剂量、不能保证没事、不能说医生错了。

请回答用户最关心的五件事：
1. 大概可能是什么方向（不超过 3 个）
2. 为什么这样判断
3. 现在可以先怎么处理
4. 是否可以了解非处方药类别或药品信息
5. 什么情况下必须就医

输出结构：
一、大致判断       二、判断依据        三、现在可以怎么做
四、药品信息说明   五、什么时候必须就医 六、是否需要继续补充

语言要求：简单、直接、不吓人、不像病历、不堆医学术语、适合普通用户和长辈阅读。
```

### 4.5 可选 Prompt：药品信息说明

**使用位置：** 用户明确问某个药，或询问 OTC 药品类别时。

**Prompt 摘要：**
```
你是"问康"的非处方药信息说明助手。
你不能开药、不能给剂量、不能推荐处方药、不能说"你就用这个"。

输出：
一、这个药或药品类别主要用于什么症状
二、它不适合哪些情况
三、使用前需要注意什么
四、哪些人群需要先问医生或药师
五、什么情况下不能继续自行处理，需要就医
六、当前用户情况是否适合了解该类药品信息

高风险人群（儿童、孕妇、老人、慢病患者、正在服药者）应提高风险提醒。
复方感冒药要提醒避免重复服用相同成分。
滴眼液要提醒眼痛、畏光、视力下降、明显眼红时不要长期自行用药。
```

### 4.6 回复表达风格规范

**原则：** 清楚、克制、易懂、可信。不太晦涩，也不过口语化。不是论文，也不是聊天陪伴机器人。

| 不推荐 | 推荐 |
| --- | --- |
| 这个可能是心血管问题，赶紧去医院吧。 | 当前信息提示需要优先排查心血管相关风险，尤其要确认持续时间、是否出汗、是否放射痛。 |
| 你这个大概率就是普通感冒。 | 目前更像常见呼吸道感染或气道刺激，但仍需观察发热、痰色、呼吸困难等变化。 |
| 可能为前庭性眩晕。 | 可能与前庭系统相关，也就是耳内平衡功能异常；但仍需结合发作方式、持续时间和神经系统症状判断。 |

## 5. AI 平台与模型配置

### 5.1 平台

| 项目 | 选择 |
| --- | --- |
| AI 平台 | OpenRouter |
| 首选模型 | `deepseek/deepseek-v4-pro` |
| 备选模型 | `deepseek/deepseek-v4-flash` |
| API Endpoint | `POST https://openrouter.ai/api/v1/chat/completions` |

### 5.2 环境变量

```env
AI_ENABLED="true"
OPENROUTER_API_KEY=""
OPENROUTER_MODEL="deepseek/deepseek-v4-pro"
OPENROUTER_FALLBACK_MODEL="deepseek/deepseek-v4-flash"
OPENROUTER_REFERER="http://localhost:5173"
OPENROUTER_APP_TITLE="CareCue"
AI_TIMEOUT_MS="20000"
FIRECRAWL_API_KEY=""
```

**要求：**
- API Key 只允许存在服务端环境变量中
- 前端不能直接调用 OpenRouter 或 Firecrawl
- 模型 ID 必须可通过环境变量切换，不写死在业务代码
- 未配置 API Key 或调用失败时，必须 fallback 到阶段 2 规则结果
- 如果 `json_schema` 支持不稳定，应降级为 `json_object` + 本地 Zod 校验 + 失败 fallback

### 5.3 OpenRouter 结构化输出（Zod Schema）

```typescript
import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.OPENROUTER_REFERER,
    "X-OpenRouter-Title": process.env.OPENROUTER_APP_TITLE,
  }
});

const StateExtractionSchema = z.object({
  currentSymptoms: z.array(z.string()).describe("当前已提取的所有症状"),
  possibleConditions: z.array(z.string()).describe("疑似方向"),
  missingCriticalInfo: z.array(z.string()).describe("缺失的关键鉴别信息"),
  searchQueries: z.array(z.string()).describe("需要执行的权威检索词"),
});

async function extractState(messages) {
  const completion = await openai.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-pro",
    messages: messages,
    response_format: zodResponseFormat(StateExtractionSchema, "state_extraction"),
  });
  return JSON.parse(completion.choices[0].message.content);
}
```

### 5.4 AI 输出 JSON Schema

AI 必须输出固定结构，不允许自由文本直接渲染。

```typescript
type AiAnalysisResult = {
  aiStatus: 'success' | 'fallback'
  aiSummary: string
  possibleDirections: Array<{
    title: string
    support: string[]
    caution: string[]
    suggestedAction: string
  }>
  missingInformation: string[]
  departmentSuggestion: string
  nextSteps: string[]
  dailyAdvice: string[]
  uncertaintyItems: string[]
  doctorSummary: string
  safetyFlags: string[]
}
```

| 字段 | 展示位置 | 要求 |
| --- | --- | --- |
| `aiSummary` | AI 综合分析 | 解释可能方向，不得确诊 |
| `possibleDirections` | 可能方向卡片 | 2-4 个方向，每项必须有支持点和注意点 |
| `missingInformation` | 缺失信息 | 没有缺失时返回空数组 |
| `departmentSuggestion` | 建议科室 | 不能覆盖 A 级急诊 |
| `nextSteps` | 下一步 | 给出观察、记录、就诊准备等建议 |
| `dailyAdvice` | 日常注意 | 不得包含药物剂量或处方建议 |
| `uncertaintyItems` | 不确定项 | 明确线上信息不足 |
| `doctorSummary` | 医生摘要 | 可复制，语言客观 |
| `safetyFlags` | 安全检查 | 标记是否出现红旗风险或模型限制 |

## 6. 红旗规则优先级

阶段 3 保持规则优先：

- 规则结果为 A 级时，AI 不允许降级
- 规则结果为高风险时，结果页顶部必须保留高风险提示
- AI 可以补充解释，但不能弱化红旗风险
- AI 不能把"需要线下评估"改成"可以放心观察"

**UI 表达按风险等级区分：**

| 等级 | 页面表达 |
| --- | --- |
| A | 明确提示存在急症风险，建议优先线下急诊评估 |
| B | 建议尽快就医或 24-48 小时内评估 |
| C | 建议门诊评估，重点说明可能方向和补充信息 |
| D | 可先观察变化，给出观察指标和日常建议 |

## 7. Firecrawl 检索引擎

### 7.1 使用规范

- **按需搜索（Lazy Search）：** 不是每句话都搜索。只有当提取到核心医学实体或需要鉴别诊断依据时才调用 Firecrawl。
- **白名单限制：** 搜索词强制追加权威网站限制，后端根据来源白名单拼接 site 限定词。
- **引用留存：** 抓取到的 sourceURL 和 title 在最终报告"参考依据"模块展示。

### 7.2 搜索参数配置

```typescript
import FirecrawlApp from '@mendable/firecrawl-js';

const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

const searchResponse = await app.search(
  "老年人 持续头晕 伴随恶心 常见原因 (site:nhc.gov.cn OR site:nmpa.gov.cn OR site:dxy.cn OR site:chinacdc.cn OR site:msdmanuals.cn)",
  {
    limit: 3,
    scrapeOptions: {
      formats: ['markdown'],
      onlyMainContent: true
    }
  }
);
```

### 7.3 并发优化

多个 searchQueries 使用 `Promise.allSettled` 并发调用：

```typescript
async function executeSearches(queries: string[]) {
  const searchPromises = queries.map(query =>
    app.search(query, {
      limit: 2,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true }
    })
  );
  const results = await Promise.allSettled(searchPromises);
  return results
    .filter(r => r.status === 'fulfilled' && r.value.success)
    .flatMap(r => (r as PromiseFulfilledResult<any>).value.data);
}
```

## 8. 前端交互设计

### 8.1 聊天互动窗口（适老化）

1. **"思考中"状态感知：** 后台处理耗时 3-8 秒，前端展示阶段性动画："正在整理您的症状..." → "正在查阅权威医学资料..." → "正在对比分析..."。

2. **结构化追问交互：** AI 下发的追问必须是"口语化问题 + 大按钮选项 + 其他(补充文本框)"，用户点击按钮即回复，不需打字。

3. **随时可终止：** 用户可随时点击"结束追问，直接看建议"，系统基于已有信息生成保守报告。

4. **进度暗示：** 顶部/侧边展示温和提示："我们正在逐步了解您的情况，通常还需回答 1-2 个问题"。后台设定最大追问 3 轮。

### 8.2 AI 结果页结构

1. **顶部风险横幅：** 紧急程度 A/B/C/D + 风险标题 + 行动建议。A/B 级突出就医时机，C/D 级突出分析和观察。
2. **AI 综合分析：** 症状解释、判断依据、支持与不支持点。
3. **可能方向卡片：** 2-4 个方向，每张含方向名称、支持点、仍需注意、建议动作。
4. **缺失信息：** AI 判断还缺的关键字段。
5. **建议科室与下一步：** 科室、就医时机、就医前准备、观察指标。
6. **医生沟通摘要：** 可复制，AI 优化表达但保持客观克制。
7. **安全边界与不确定项：** 固定展示，不允许 AI 删除。

## 9. 数据存储

### 9.1 最小表设计

| 表 | 作用 | 阶段 |
| --- | --- | --- |
| users | 用户登录身份和基础信息 | 阶段 2 |
| consultation_records | 一次咨询的主记录 | 阶段 2 |
| consultation_answers | 追问问题和用户回答 | 阶段 2 |
| consultation_results | 风险等级、可能方向、科室建议、医生摘要 | 阶段 2 |
| patient_profiles | 本人或家人健康画像 | 阶段 5 |
| source_references | 联网检索来源 | 阶段 4 |
| model_runs | 模型调用、Prompt 版本、输出状态 | 阶段 3 |

### 9.2 consultation_results 扩展字段

| 字段 | 说明 |
| --- | --- |
| `ai_status` | success / fallback / disabled / error |
| `ai_model` | 实际调用模型 ID |
| `ai_summary` | AI 综合分析 |
| `missing_information` | JSON 数组 |
| `next_steps` | JSON 数组 |
| `safety_flags` | JSON 数组 |

### 9.3 数据原则

- 核心业务数据不存浏览器 localStorage
- 前端只保存短期登录态和必要界面状态
- 健康数据按用户 ID 隔离
- 后续涉及敏感信息加密、审计日志和数据导出删除

## 10. 错误处理与 Fallback

### 10.1 失败场景

- 未配置 `OPENROUTER_API_KEY`
- OpenRouter 超时
- 模型返回非 JSON
- JSON Schema 校验失败
- 模型输出包含禁止措辞
- Firecrawl 检索超时/无结果/来源不可用

### 10.2 Fallback 行为

- 展示阶段 2 规则结果
- 页面提示"本次 AI 分析暂不可用，已展示规则分析结果"
- 检索失败时显示"本次未能完成联网查证"，不生成假链接
- 咨询记录仍保存，历史记录中标记 `aiStatus: "fallback"`
- 模型超时或失败时用户不丢失已填写内容

## 11. 代码模块结构

### 11.1 服务端

```
server/
  index.ts              # Express 入口
  auth.ts               # 登录注册鉴权
  rules.ts              # 规则引擎（场景识别、危险判断、结果生成）
  rules.test.ts         # 规则测试
  agent.ts              # Agentic Workflow 核心（状态提取、检索路由、追问/报告生成）
  ai.ts                 # AI Gateway（OpenRouter 调用封装）
  ai-schema.ts          # AI 输出 JSON Schema / Zod 校验
  ai-prompt.ts          # Prompt 模板管理
  db.ts                 # Prisma 客户端
  routes/
    auth.ts             # /api/auth/*
    consultations.ts    # /api/consultations/*
```

### 11.2 前端

```
src/
  App.tsx               # 主应用入口
  components/
    LandingPage.tsx      # 首页
    AuthPage.tsx         # 登录/注册
    ConsultationEntry.tsx # 咨询入口
    ChatInterface.tsx    # 聊天互动窗口（阶段 3 新增）
    ResultPage.tsx       # 结果页
    HistoryList.tsx      # 历史记录
```

## 12. 质量门槛

所有阶段都必须通过以下命令：
- `npm run test:api` — API 集成测试
- `npm run test:rules` — 规则场景测试
- `npm run typecheck:api` — 类型检查
- `npm run lint` — 代码规范检查
- `npm run build` — 构建验证

## 13. 安全要求

- 登录态保护（JWT httpOnly Cookie）
- 防止越权查看他人记录（按 user_id 隔离）
- API Key 不出现在前端 bundle
- OpenRouter/Firecrawl 调用只发生在服务端
- 敏感数据加密存储
- API 限流
- Prompt 注入防护
- 管理员操作审计

## 14. 结束条件

AI 交互不以"确诊疾病"为结束。结束条件是**已经足够给用户下一步行动建议**：

- 命中高危，建议及时就医
- 轻度常见问题，给处理和观察建议
- 疾病方向不唯一，说明可能方向和不确定点
- 用户问药，给药品信息说明和风险提醒
- 信息始终不足，停止追问，说明需要补充什么或建议就医
- 用户已经获得可执行建议
