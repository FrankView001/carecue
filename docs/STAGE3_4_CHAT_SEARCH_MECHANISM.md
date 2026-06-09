# 问康 CareCue 核心交互与检索机制设计方案 (阶段 3 & 4)

## 1. 核心交互机制概述

在用户完成前置的基础症状卡片（主诉、年龄、持续时间等）填写后，系统将从“单向问卷”平滑过渡到“AI 智能诊断与追问”的**聊天互动窗口**。
为确保信息准确、安全且避免 AI 幻觉，整个交互机制采用 **“分析 -> 检索 -> 验证 -> 追问/总结”** 的多轮状态机（State Machine）循环模型。

核心目标是：**不轻易下定论，通过 Firecrawl 权威检索交叉验证，必要时向用户追问关键差异化症状，直至信息充足或触发红旗警告，最终输出结构化报告。**

---

## 2. 后台核心机制设计 (AI + Search Engine)

后台处理不再是简单的一次性大模型 API 调用，而是设计为一个 **Agentic Workflow（智能体工作流）**。每次用户回复后，后台按以下步骤执行：

### 步骤 1：状态理解与关键词提取 (AI 拆分)
- **输入**：用户基础信息 + 历史对话记录 + 最新回复。
- **动作**：大模型对当前状态进行结构化拆分。
- **输出**：
  - `current_symptoms`: 提取出的所有症状（如：胸痛、左侧、刺痛、3天）。
  - `possible_conditions`: 当前怀疑的初步方向（如：心绞痛、肋间神经痛、胃食管反流）。
  - `missing_critical_info`: 区分这些怀疑方向还缺少的关键鉴别信息（如：是否与呼吸/咳嗽有关？是否有进食后加重？）。
  - `search_queries`: 针对当前怀疑方向或不确定症状，生成的搜索引擎 Query（如：“胸痛 刺痛 呼吸加重 鉴别诊断 site:nhc.gov.cn”）。

### 步骤 2：定向权威检索 (Firecrawl 介入)
- **触发条件**：当 AI 提取出新的 `search_queries`，且该信息尚未在本次会话中检索过时。
- **动作**：通过 Firecrawl API 执行定向搜索。
- **搜索策略**：
  - **白名单限制**：搜索词强制追加权威网站限制（如 `site:dxy.cn` 或 `site:mayoclinic.org` 等医疗白名单）。
  - **内容抓取**：利用 Firecrawl 获取搜索结果及页面 Markdown 摘要。
- **输出**：权威医疗来源的参考文本及链接。

### 步骤 3：交叉验证与风险评估 (AI 综合)
- **动作**：大模型结合“步骤1的症状”和“步骤2的检索结果”进行交叉验证。
- **评估逻辑**：
  1. **红旗验证**：当前症状是否匹配检索到的高危疾病（如急性心梗）特征？如果是，立即中断，输出 A级急诊建议。
  2. **证据匹配度**：用户的症状库与检索到的几种可能疾病，哪个匹配度最高？
  3. **信息充足度**：是否还有关键的鉴别症状用户没说清楚？

### 步骤 4：决策路由 (Decision Routing)
基于交叉验证的结果，后台决定下一步动作并返回给前端：
- **分支 A：继续追问 (Ask Question)**
  - 条件：信息不足以给出安全建议，或需要排除高危风险。
  - 动作：AI 生成一个易懂的追问问题，并附带 2-4 个选项（如：“您深呼吸或者咳嗽的时候，胸痛会加重吗？” 选项：“会加重”、“没有变化”、“不清楚”）。
- **分支 B：生成报告 (Generate Report)**
  - 条件：经过 2-3 轮追问，信息已足够清晰，或者用户多次表示“不清楚”，无法继续深入。
  - 动作：结合所有聊天记录和 Firecrawl 检索链接，生成包含“可能方向”、“就医建议”、“日常注意”和“医生摘要”的最终报告，并结束对话。

---

## 3. 前台用户交互设计 (适老化与低门槛)

在聊天互动窗口，前端需保证长辈用户不会感到迷茫和压迫：

1. **“思考中”的状态感知**：
   - 由于后台需要“提取 -> 搜索 -> 验证”，耗时可能较长（3-8秒）。
   - 前端需要展示阶段性动画，如：`正在整理您的症状...` -> `正在查阅权威医学资料...` -> `正在对比分析...`，缓解用户等待焦虑。
2. **结构化追问交互 (防长文本输入)**：
   - AI 下发的追问不能只是一句话让用户自己打字。
   - 必须是 **“口语化问题 + 大按钮选项 + 其他(补充文本框)”**。
   - 例如：AI 问“头晕的时候觉得天旋地转吗？” -> 提供按钮 [是的，感觉周围在转] [不是，只是觉得头重脚轻] [记不清了]。用户点击即回复。
3. **随时可终止**：
   - 用户可以随时点击“结束追问，直接看建议”按钮。系统将基于已有信息生成不确定性较高的保守报告。
4. **进度暗示**：
   - 界面顶部或侧边展示一个温和的提示：“我们正在逐步了解您的情况，通常还需回答 1-2 个问题”。（后台设定最大追问轮数，如最多 3 轮，避免无休止提问）。

---

## 4. Firecrawl 引擎具体使用规范

- **按需搜索 (Lazy Search)**：不是用户每发一句话都搜索。只有当提取到核心医学实体（如特定疾病名、罕见症状组合）或需要鉴别诊断依据时，才调用 Firecrawl。
- **搜索参数配置 (基于 `@mendable/firecrawl-js` 最新规范)**：
  ```typescript
  import FirecrawlApp from '@mendable/firecrawl-js';

  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  // 严格依据 PRD 第 9.2 节的权威来源白名单
  const searchResponse = await app.search(
    "老年人 持续头晕 伴随恶心 常见原因 (site:nhc.gov.cn OR site:nmpa.gov.cn OR site:dxy.cn OR site:chinacdc.cn OR site:msdmanuals.cn)", 
    {
      limit: 3, // 只取前3条最相关的权威结果
      scrapeOptions: {
        formats: ['markdown'], // 直接获取清理后的 Markdown 正文
        onlyMainContent: true  // 过滤网页导航、广告等杂讯
      }
    }
  );

  if (searchResponse.success) {
    const results = searchResponse.data;
    // 处理 results[].markdown 和 results[].metadata.title/sourceURL
  }
  ```
- **引用留存**：Firecrawl 抓取到的 `sourceURL` 和 `title` 必须在后端上下文中保存。如果最终报告使用了该知识点，必须在结果页的“参考依据”模块展示出来，做到言之有据。

---

## 5. 技术实现参考 (TypeScript + 最新 SDK)

为了保证机制的稳定性，后端代码应采用最新语言特性和官方 SDK：

### 5.1 OpenRouter 结构化输出 (基于 OpenAI SDK + Zod)
使用 `openai` SDK 连接 OpenRouter，并结合 `zod` 强制模型输出 JSON Schema，确保状态机流转不会因为 AI 幻觉崩溃。

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

// 定义严格的状态提取 Schema
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

### 5.2 并发优化
当提取到多个 `searchQueries` 时，使用 `Promise.allSettled` 并发调用 Firecrawl，大幅降低搜索等待时间。

```typescript
async function executeSearches(queries: string[]) {
  const searchPromises = queries.map(query => 
    app.search(query, { limit: 2, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } })
  );
  
  const results = await Promise.allSettled(searchPromises);
  // 聚合成功的检索结果注入到下一轮 AI Prompt 中
  return results
    .filter(r => r.status === 'fulfilled' && r.value.success)
    .flatMap(r => (r as PromiseFulfilledResult<any>).value.data);
}
```

---

## 6. 总结流程图

```text
[用户提交基础卡片] 
       │
       ▼
[前端进入聊天互动窗口] ──(发送状态)──▶ 【后台 API】
                                      │
                 ┌────────────────────┴────────────────────┐
                 │ 1. AI 提取: 症状(S), 缺失(M), 搜索词(Q) │
                 └────────────────────┬────────────────────┘
                                      │ (是否有新 Q?)
                       [有] ──────────┴────────── [无/已搜过]
                        │                           │
            ┌───────────▼───────────┐               │
            │ 2. Firecrawl 权威搜索 │               │
            └───────────┬───────────┘               │
                        │                           │
                 ┌──────▼───────────────────────────▼──────┐
                 │ 3. AI 交叉验证 (症状对比、红旗拦截)     │
                 └────────────────────┬────────────────────┘
                                      │
                      [信息不足] ──────┴────── [信息充足/红旗]
                          │                           │
                ┌─────────▼─────────┐       ┌─────────▼─────────┐
                │ 4A. 生成追问及选项│       │ 4B. 生成最终报告  │
                └─────────┬─────────┘       └─────────┬─────────┘
                          │                           │
[前端渲染追问卡片] ◀──────┘                           │
[用户点击选项] ─────(循环)                            │
                                                      ▼
                                          [前端展示包含引用的结果页]
```
