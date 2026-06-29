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

/** 默认无操作，避免测试与生产无谓开销。 */
export const noopTracer: Tracer = {
  log() {},
  events() {
    return []
  },
}

/** 内存追踪器：可回放、可 debug；M3 可替换为 PG sink。 */
export class MemoryTracer implements Tracer {
  private readonly buffer: TraceEvent[] = []
  private readonly echo: boolean

  constructor(options: { echo?: boolean } = {}) {
    this.echo = options.echo ?? false
  }

  log(event: Omit<TraceEvent, 'ts'>): void {
    const full: TraceEvent = { ts: Date.now(), ...event }
    this.buffer.push(full)
    if (this.echo) {
      const dur = full.durationMs !== undefined ? ` ${full.durationMs}ms` : ''
      console.log(`[trace] ${full.kind}/${full.name}${dur} (${full.caseId})`)
    }
  }

  events(caseId?: string): TraceEvent[] {
    return caseId ? this.buffer.filter((e) => e.caseId === caseId) : [...this.buffer]
  }
}
