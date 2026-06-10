# 问康 CareCue

问康 CareCue 是面向长辈、子女和不熟悉搜索用户的就医前健康咨询产品。

当前使用 **Agent 3.0** 对话式咨询：用户描述症状后，服务端多轮追问、风险研判、可选联网核查，并输出阶段/最终报告。

## 已初始化能力

- React + TypeScript + Vite 前端
- Express API 服务
- Prisma 7 + PostgreSQL 数据模型
- 手机号/邮箱 + 密码注册登录
- bcrypt 密码哈希
- JWT httpOnly Cookie 会话
- 用户隔离的咨询记录 API（列表、详情、删除）
- 就医前症状整理对话咨询（`POST /api/agent/consult`、`POST /api/agent/consult/stream`）
- SSE 流式展示可审计分析过程
- 红旗风险识别与急诊提示
- Firecrawl 联网核查（需配置 `FIRECRAWL_API_KEY`）
- OpenRouter LLM 调用、结构化输出与本地降级
- 历史咨询列表、详情、删除
- 注册、登录、Cookie 会话和受保护接口 API 集成测试
- Agent 3.0 单元测试（状态合并、风险、搜索失败恢复等）
- Vite 同源 `/api` 代理，避免本地 `localhost` / `127.0.0.1` Cookie 会话不一致

## 文档

- [产品需求文档](docs/PRD.md)
- [技术设计文档](docs/TECHNICAL.md)
- [测试文档](docs/TESTING.md)

## 本地启动

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

启动 PostgreSQL：

```powershell
docker compose up -d postgres
```

生成 Prisma Client 并创建迁移：

```powershell
npm run prisma:generate
npm run prisma:migrate
```

分别启动 API 和前端：

```powershell
npm run dev:api
npm run dev
```

默认地址：

- 前端：http://localhost:5173
- API：http://127.0.0.1:4300/api

## 验证

```powershell
npm run test:api
npm run test:agent
npm run lint
npm run typecheck:api
npm run build
```

`npm run test:api` 需要 API 服务已启动。覆盖注册、登录、会话校验、Agent 受保护接口、用户记录隔离、登出 Cookie 清理、同源代理 Cookie 连续性等场景。

`npm run test:agent` 不依赖数据库或 API 服务。覆盖状态合并、年龄校验、幂等去重、搜索失败继续分析、报告渲染等 Agent 3.0 核心行为。

## 下一步计划

1. 固化回归：每次改动后运行 `npm run test:api`、`npm run test:agent`、`npm run lint`、`npm run typecheck:api`、`npm run build`。
2. 做移动端和宽屏 UI 验收：重点检查对话区、分析过程侧栏和结果页是否溢出或遮挡。
3. 优化错误提示：区分网络异常、登录失效、重复注册、错误密码。
4. 完善联网核查：配置 `FIRECRAWL_API_KEY`，验收来源白名单与引用展示。

## 阶段边界

当前阶段暂不包含短信验证码、微信登录和 PDF 导出。未配置 `OPENROUTER_API_KEY` 或 `AI_ENABLED` 不是 `true` 时，Agent 会使用本地确定性降级继续给出建议。配置 `FIRECRAWL_API_KEY` 后，服务端可通过 Firecrawl 进行联网核查。
