import 'dotenv/config'
import bcrypt from 'bcrypt'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import jwt from 'jsonwebtoken'
import morgan from 'morgan'
import { z } from 'zod'
import { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { PrismaPg } from '@prisma/adapter-pg'
import { createCareCueAgentRuntime, type AgentResponse, type AgentStreamEvent, type CaseState } from './agent/index.ts'
import { buildStateSnapshot } from './agent/agentResponse.ts'
import { PrismaCaseStore, persistChatTurn, isPersistableEvent } from './chatStore.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { traceLogDir } from './agent/logs/traceLogger.ts'

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://carecue:carecue@localhost:5432/carecue?schema=public',
})
const prisma = new PrismaClient({ adapter })
const app = express()
const port = Number(process.env.PORT ?? 4300)
const host = process.env.HOST ?? '127.0.0.1'
const jwtSecret = process.env.JWT_SECRET ?? 'carecue-local-dev-secret'
const authCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
} satisfies express.CookieOptions
const clientOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

app.use(helmet())
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || clientOrigins.includes(origin)) {
        callback(null, true)
        return
      }

      callback(new Error(`CORS origin is not allowed: ${origin}`))
    },
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use(morgan('dev'))

type AuthedRequest = express.Request & {
  userId?: string
}

const loginSchema = z.object({
  account: z.string().trim().min(3),
  password: z.string().min(6),
})

const registerSchema = loginSchema.extend({
  displayName: z.string().trim().min(1).max(24).optional(),
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'carecue-api' })
})

app.post('/api/auth/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: '请输入手机号/邮箱和至少 6 位密码。' })
  }

  const { account, password, displayName } = parsed.data
  const where = accountWhere(account)
  const existing = await prisma.user.findFirst({ where })
  if (existing) {
    return res.status(409).json({ message: '该账号已注册，请直接登录。' })
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.create({
    data: {
      ...accountData(account),
      passwordHash,
      displayName: displayName || defaultDisplayName(account),
      lastLoginAt: new Date(),
    },
  })

  setAuthCookie(res, user.id)
  return res.status(201).json({ user: publicUser(user) })
})

app.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: '请输入账号和密码。' })
  }

  const { account, password } = parsed.data
  const user = await prisma.user.findFirst({ where: accountWhere(account) })
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ message: '账号或密码不正确。' })
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })

  setAuthCookie(res, updated.id)
  return res.json({ user: publicUser(updated) })
})

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('carecue_token', authCookieOptions)
  return res.json({ ok: true })
})

app.get('/api/auth/me', requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } })
  if (!user) {
    return res.status(401).json({ message: '登录状态已失效。' })
  }

  return res.json({ user: publicUser(user) })
})

app.get('/api/consultations', requireAuth, async (req: AuthedRequest, res) => {
  const records = await prisma.consultationRecord.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    include: { result: true },
  })

  return res.json({
    records: records.map((record) => ({
      id: record.id,
      chiefComplaint: record.chiefComplaint,
      scenario: record.scenario,
      riskLevel: record.riskLevel,
      urgencyLevel: record.result?.urgencyLevel,
      departmentSuggestion: record.result?.departmentSuggestion,
      createdAt: record.createdAt,
    })),
  })
})

app.get('/api/consultations/:id', requireAuth, async (req: AuthedRequest, res) => {
  const recordId = paramAsString(req.params.id)
  const record = await prisma.consultationRecord.findFirst({
    where: { id: recordId, userId: req.userId },
    include: consultationInclude,
  })

  if (!record) {
    return res.status(404).json({ message: '没有找到该咨询记录。' })
  }

  return res.json({ record: serializeRecord(record) })
})

app.delete('/api/consultations/:id', requireAuth, async (req: AuthedRequest, res) => {
  const recordId = paramAsString(req.params.id)
  const record = await prisma.consultationRecord.findFirst({
    where: { id: recordId, userId: req.userId },
    select: { id: true },
  })

  if (!record) {
    return res.status(404).json({ message: '没有找到该咨询记录。' })
  }

  await prisma.consultationRecord.delete({ where: { id: record.id } })
  return res.json({ ok: true })
})

// ==========================================
// CareCue Agent v3.0 — CaseState 驱动的工具主循环
// ==========================================

// CaseState 持久化到 PostgreSQL：页面刷新 / 服务重启后会话可恢复、可继续
const agentRuntime = createCareCueAgentRuntime({ caseStore: new PrismaCaseStore(prisma) })

const agentConsultSchema = z.object({
  caseId: z.string().uuid().optional(),
  message: z.string().trim().min(2).max(2000),
})

app.post('/api/agent/consult', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = agentConsultSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: '请先简单描述哪里不舒服（2-2000 字）。' })
  }

  try {
    const response = await agentRuntime.run({
      caseId: parsed.data.caseId,
      userId: req.userId,
      userMessage: parsed.data.message,
    })

    await persistChatTurn(prisma, {
      userId: req.userId!,
      userMessage: parsed.data.message,
      response,
    }).catch((error) => console.error('[Agent] persist chat turn failed', error))

    // 最终报告 / 急症提醒落库，供历史记录页查看
    let record: ReturnType<typeof serializeRecord> | undefined
    if (response.type === 'final_report' || response.type === 'emergency') {
      try {
        record = await persistAgentOutcome(req.userId!, response)
      } catch (error) {
        console.error('[Agent] persist consultation record failed', error)
      }
    }

    return res.json({ response, record })
  } catch (error) {
    console.error('[Agent] consult failed', error)
    return res.status(500).json({ message: '分析服务暂时不可用，请稍后重试。' })
  }
})

// SSE 流式咨询：推送可审计分析过程（状态/已提取信息/风险核查/检索词/来源），最后推送 final
app.post('/api/agent/consult/stream', requireAuth, async (req: AuthedRequest, res) => {
  const parsed = agentConsultSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: '请先简单描述哪里不舒服（2-2000 字）。' })
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // 过程事件随 SSE 下发的同时收集起来，随助手消息一起落库（历史还原"分析过程"用）
  const collectedEvents: AgentStreamEvent[] = []
  const send = (event: AgentStreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    if (isPersistableEvent(event)) {
      collectedEvents.push(event)
    }
  }

  try {
    const response = await agentRuntime.run({
      caseId: parsed.data.caseId,
      userId: req.userId,
      userMessage: parsed.data.message,
      onEvent: send,
    })

    await persistChatTurn(prisma, {
      userId: req.userId!,
      userMessage: parsed.data.message,
      response,
      events: collectedEvents,
    }).catch((error) => console.error('[Agent] persist chat turn failed', error))

    let record: ReturnType<typeof serializeRecord> | undefined
    if (response.type === 'final_report' || response.type === 'emergency') {
      try {
        record = await persistAgentOutcome(req.userId!, response)
      } catch (error) {
        console.error('[Agent] persist consultation record failed', error)
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'final', response, record })}\n\n`)
  } catch (error) {
    console.error('[Agent] consult stream failed', error)
    send({ type: 'error', message: '分析服务暂时不可用，请稍后重试。' })
  } finally {
    res.end()
  }
})

// ==========================================
// 聊天会话历史 — 列表 / 详情（含消息与状态快照）/ 删除
// 刷新页面或从历史进入时，前端用这些接口还原完整对话并继续聊天
// ==========================================

app.get('/api/chats', requireAuth, async (req: AuthedRequest, res) => {
  const sessions = await prisma.chatSession.findMany({
    where: { userId: req.userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      status: true,
      riskLevel: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  })

  return res.json({
    sessions: sessions
      .filter((s) => s._count.messages > 0)
      .map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        riskLevel: s.riskLevel,
        messageCount: s._count.messages,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
  })
})

app.get('/api/chats/:id', requireAuth, async (req: AuthedRequest, res) => {
  const sessionId = paramAsString(req.params.id)
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: req.userId },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })

  if (!session) {
    return res.status(404).json({ message: '没有找到该对话。' })
  }

  return res.json({
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      riskLevel: session.riskLevel,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    },
    messages: session.messages.map((m) => ({
      id: m.id,
      role: m.role,
      kind: m.kind,
      content: m.content,
      payload: m.payload,
      createdAt: m.createdAt,
    })),
    snapshot: session.caseState ? buildStateSnapshot(session.caseState as unknown as CaseState) : null,
  })
})

app.delete('/api/chats/:id', requireAuth, async (req: AuthedRequest, res) => {
  const sessionId = paramAsString(req.params.id)
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: req.userId },
    select: { id: true },
  })

  if (!session) {
    return res.status(404).json({ message: '没有找到该对话。' })
  }

  await prisma.chatSession.delete({ where: { id: session.id } })
  return res.json({ ok: true })
})

const AGENT_RISK_TO_LEGACY: Record<string, { riskLevel: string; urgencyLevel: string; urgencyTitle: string }> = {
  R3: { riskLevel: 'high', urgencyLevel: 'A', urgencyTitle: '建议立即就医或联系急救' },
  R2: { riskLevel: 'medium', urgencyLevel: 'B', urgencyTitle: '建议尽快就医检查' },
  R1: { riskLevel: 'low', urgencyLevel: 'C', urgencyTitle: '建议择期就诊，先观察' },
  R0: { riskLevel: 'low', urgencyLevel: 'D', urgencyTitle: '暂未发现明显危险信号' },
}

async function persistAgentOutcome(userId: string, response: AgentResponse) {
  const legacy = AGENT_RISK_TO_LEGACY[response.riskLevel] ?? AGENT_RISK_TO_LEGACY.R1
  const chiefComplaint = response.stateSnapshot.chiefComplaint || '健康咨询'

  const resultData =
    response.type === 'final_report'
      ? {
          riskLevel: legacy.riskLevel,
          urgencyLevel: legacy.urgencyLevel,
          urgencyTitle: legacy.urgencyTitle,
          urgencyAdvice: response.report.riskReason,
          possibleDirections: response.report.hypotheses.map((h) => ({
            title: h.name,
            support: h.supportEvidence,
            caution: [...h.againstEvidence, ...h.uncertainties],
          })),
          departmentSuggestion: response.report.departmentSuggestion,
          dailyAdvice: response.report.selfCareAdvice,
          doctorSummary: response.report.doctorSummary,
          uncertaintyItems: [response.report.uncertaintyNote],
          aiStatus: 'success',
          aiSummary: response.report.currentConclusion,
          missingInformation: response.report.unresolvedRedFlags,
          nextSteps: response.report.seekCareWhen,
          safetyFlags: response.report.avoidActions,
          sourceReferences: response.report.references,
          webSearchUsed: response.report.references.length > 0,
        }
      : {
          riskLevel: 'high',
          urgencyLevel: 'A',
          urgencyTitle: '建议立即就医或联系急救',
          urgencyAdvice: response.type === 'emergency' ? response.content : '',
          possibleDirections: [],
          departmentSuggestion: '急诊科',
          dailyAdvice: [],
          doctorSummary: response.type === 'emergency' ? response.doctorSummary : '',
          uncertaintyItems: [],
          aiStatus: 'success',
          aiSummary: response.type === 'emergency' ? response.content : '',
          missingInformation: [],
          nextSteps: [],
          safetyFlags: response.type === 'emergency' ? response.triggeredCombination : [],
          sourceReferences: [],
          webSearchUsed: false,
        }

  const record = await prisma.consultationRecord.create({
    data: {
      userId,
      chiefComplaint,
      scenario: 'agent_v3',
      riskLevel: response.type === 'emergency' ? 'high' : legacy.riskLevel,
      result: { create: resultData },
    },
    include: consultationInclude,
  })

  return serializeRecord(record)
}

// 调试面板数据（§34.2）：CaseState / Trace / MessageHistory
app.get('/api/agent/cases/:caseId/debug', requireAuth, async (req: AuthedRequest, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.AGENT_DEBUG_PANEL !== 'true') {
    return res.status(404).json({ message: 'Not found.' })
  }
  const caseId = paramAsString(req.params.caseId)
  if (!caseId) {
    return res.status(400).json({ message: '缺少 caseId。' })
  }
  const debug = await agentRuntime.getDebugInfo(caseId)
  if (!debug.state) {
    return res.status(404).json({ message: '没有找到该病例。' })
  }
  return res.json(debug)
})

// 导出完整 Trace JSONL（§v3.1）：仅开发环境，或生产环境显式开启 AGENT_DEBUG_PANEL
app.get('/api/debug/traces/:traceId', requireAuth, (req: AuthedRequest, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.AGENT_DEBUG_PANEL !== 'true') {
    return res.status(404).json({ message: 'Not found.' })
  }
  const traceId = paramAsString(req.params.traceId)
  if (!traceId || !/^[a-zA-Z0-9-]+$/.test(traceId)) {
    return res.status(400).json({ message: '缺少或非法的 traceId。' })
  }
  try {
    const file = join(traceLogDir(), `${traceId}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    const events = lines.map((line) => JSON.parse(line))
    return res.json({ traceId, eventCount: events.length, events })
  } catch {
    return res.status(404).json({ message: '没有找到该 Trace（traceId 不存在或日志未落盘）。' })
  }
})

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  void _next
  console.error(err)
  return res.status(500).json({ message: '服务暂时不可用，请稍后重试。' })
})

const server = app.listen(port, host, () => {
  console.log(`CareCue API listening on http://${host}:${port}`)
})

server.on('error', (error) => {
  console.error('CareCue API failed to start', error)
  process.exit(1)
})

function requireAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction) {
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '')
  const token = req.cookies?.carecue_token || bearer

  if (!token) {
    return res.status(401).json({ message: '请先登录。' })
  }

  try {
    const payload = jwt.verify(token, jwtSecret) as { userId: string }
    req.userId = payload.userId
    return next()
  } catch {
    return res.status(401).json({ message: '登录状态已失效，请重新登录。' })
  }
}

function setAuthCookie(res: express.Response, userId: string) {
  const token = jwt.sign({ userId }, jwtSecret, { expiresIn: '7d' })
  res.cookie('carecue_token', token, authCookieOptions)
}

function accountWhere(account: string) {
  return account.includes('@') ? { email: account.toLowerCase() } : { phone: account }
}

function accountData(account: string) {
  return account.includes('@') ? { email: account.toLowerCase() } : { phone: account }
}

function defaultDisplayName(account: string) {
  if (account.includes('@')) {
    return account.split('@')[0]
  }

  return `用户${account.slice(-4)}`
}

function publicUser(user: { id: string; phone: string | null; email: string | null; displayName: string; lastLoginAt: Date | null }) {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    displayName: user.displayName,
    lastLoginAt: user.lastLoginAt,
  }
}

const consultationInclude = {
  answers: { orderBy: { createdAt: 'asc' } },
  result: true,
} satisfies Prisma.ConsultationRecordInclude

type ConsultationWithDetails = Prisma.ConsultationRecordGetPayload<{
  include: typeof consultationInclude
}>

function serializeRecord(record: ConsultationWithDetails) {
  return {
    id: record.id,
    chiefComplaint: record.chiefComplaint,
    scenario: record.scenario,
    riskLevel: record.riskLevel,
    status: record.status,
    createdAt: record.createdAt,
    answers: record.answers,
    result: record.result,
  }
}

function paramAsString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}
