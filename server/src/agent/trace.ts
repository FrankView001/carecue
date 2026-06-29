// 可观测性（设计文档 2.8）：记录工具调用 / LLM 调用 / Guard 拦截 / Workspace 快照。
// M2 用内存 + 可选 console，接口与事件结构对齐 M3 的 PG 落库（traces / workspaces 表）。

export type TraceKind = 'decision' | 'guard' | 'tool' | 'llm' | 'snapshot' | 'error'

export interface TraceEvent {
  ts: number
  caseId: string
  kind: TraceKind
  name: string
  durationMs?: number
  data?: unknown
}

export interface Tracer {
  log(event: Omit<TraceEvent, 'ts'>): void
  events(caseId?: string): TraceEvent[]
}

/** 落库后端：每个事件写一行（snapshot 走 workspaces，其余走 traces）。 */
export interface TraceSink {
  write(event: TraceEvent): void | Promise<void>
}

/** 默认无操作，避免测试与生产无谓开销。 */
export const noopTracer: Tracer = {
  log() {},
  events() {
    return []
  },
}

/** 内存追踪器：可回放、可 debug；可附加 sink 落 PG（设计文档 2.8）。 */
export class MemoryTracer implements Tracer {
  private readonly buffer: TraceEvent[] = []
  private readonly echo: boolean
  private readonly sink?: TraceSink

  constructor(options: { echo?: boolean; sink?: TraceSink } = {}) {
    this.echo = options.echo ?? false
    this.sink = options.sink
  }

  log(event: Omit<TraceEvent, 'ts'>): void {
    const full: TraceEvent = { ts: Date.now(), ...event }
    this.buffer.push(full)
    if (this.echo) {
      const dur = full.durationMs !== undefined ? ` ${full.durationMs}ms` : ''
      console.log(`[trace] ${full.kind}/${full.name}${dur} (${full.caseId})`)
    }
    if (this.sink) {
      // 落库失败绝不能影响 agent 主流程：fire-and-forget 并吞掉错误。
      void Promise.resolve(this.sink.write(full)).catch((err) => {
        console.error('[trace] sink write failed', err instanceof Error ? err.message : err)
      })
    }
  }

  events(caseId?: string): TraceEvent[] {
    return caseId ? this.buffer.filter((e) => e.caseId === caseId) : [...this.buffer]
  }
}

// ── PG 落库（设计文档 2.8：traces 一行/调用，workspaces 一行/会话含快照 JSONB） ──────

/** Prisma client 的结构化子集，避免在未生成 client 时硬依赖其类型。 */
export interface TracePersistenceClient {
  agentTrace: { create(args: { data: Record<string, unknown> }): Promise<unknown> }
  agentWorkspace: {
    upsert(args: {
      where: { id: string }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }): Promise<unknown>
  }
}

export class PrismaTraceSink implements TraceSink {
  constructor(private readonly client: TracePersistenceClient) {}

  async write(event: TraceEvent): Promise<void> {
    if (event.kind === 'snapshot') {
      const snap = (event.data ?? {}) as { rounds?: number; riskLevel?: string }
      await this.client.agentWorkspace.upsert({
        where: { id: event.caseId },
        create: {
          id: event.caseId,
          snapshot: event.data as object,
          rounds: snap.rounds ?? 0,
          riskLevel: snap.riskLevel ?? 'R0',
        },
        update: {
          snapshot: event.data as object,
          rounds: snap.rounds ?? 0,
          riskLevel: snap.riskLevel ?? 'R0',
          updatedAt: new Date(),
        },
      })
      return
    }
    await this.client.agentTrace.create({
      data: {
        caseId: event.caseId,
        kind: event.kind,
        name: event.name,
        durationMs: event.durationMs ?? null,
        data: (event.data ?? null) as object | null,
        ts: new Date(event.ts),
      },
    })
  }
}
