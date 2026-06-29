// POST /api/consult —— 约束式事件循环的 HTTP 入口（设计文档 2.2）。
// 与现有 Express 5 应用对齐；不依赖 Prisma，便于独立装配与测试。

import { Router, type Request, type Response } from 'express'
import type { ConsultEngine } from '../agent/loop.ts'

interface ConsultBody {
  caseId?: unknown
  message?: unknown
  age?: unknown
  sex?: unknown
}

export function createConsultRouter(engine: ConsultEngine): Router {
  const router = Router()

  router.post('/api/consult', async (req: Request, res: Response) => {
    const { caseId, message, age, sex } = (req.body ?? {}) as ConsultBody

    if (typeof caseId !== 'string' || !caseId.trim()) {
      res.status(400).json({ error: 'caseId 必填' })
      return
    }
    if (typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message 必填' })
      return
    }

    try {
      const result = await engine.consult({
        caseId,
        userMessage: message,
        age: typeof age === 'number' ? age : undefined,
        sex: sex === 'male' || sex === 'female' ? sex : undefined,
      })
      res.json(result)
    } catch (err) {
      // 未预期错误不暴露内部细节；具体原因落 trace / 日志。
      console.error('[consult] failed', err instanceof Error ? err.stack : err)
      res.status(500).json({ error: '分析服务暂时不可用，请稍后再试。' })
    }
  })

  return router
}
