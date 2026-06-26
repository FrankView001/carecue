// CaseState 服务 — 串行合并 + 版本管理
// 存储抽象：测试用内存实现；服务端使用 PrismaCaseStore（server/chatStore.ts）持久化到 PostgreSQL。

import { randomUUID } from 'node:crypto'
import type { CaseState, CaseStateUpdateOutput, FollowupQuestion } from './CaseState.ts'
import { createInitialCaseState } from './CaseState.ts'
import { mergeCaseState } from './caseStateMerger.ts'
import type { TraceLogger, FieldDiff } from '../logs/traceLogger.ts'
import { getByPath } from './stateFields.ts'

export interface CaseStore {
  get(caseId: string): Promise<{ state: CaseState; version: number } | undefined>
  save(caseId: string, state: CaseState, version: number): Promise<void>
}

export class InMemoryCaseStore implements CaseStore {
  private cases = new Map<string, { state: CaseState; version: number }>()

  async get(caseId: string) {
    return this.cases.get(caseId)
  }

  async save(caseId: string, state: CaseState, version: number) {
    this.cases.set(caseId, { state, version })
  }
}

export class CaseStateService {
  /** 同一 case 的合并必须串行（§20.1），用 promise 链做轻量队列 */
  private mergeQueues = new Map<string, Promise<unknown>>()

  constructor(
    private store: CaseStore,
    private traceLogger: TraceLogger,
  ) {}

  async loadOrCreate(caseId: string | undefined, userId?: string): Promise<CaseState> {
    if (caseId) {
      const existing = await this.store.get(caseId)
      if (existing) return existing.state
    }
    const id = caseId ?? randomUUID()
    const state = createInitialCaseState(id, userId)
    await this.store.save(id, state, 1)
    return state
  }

  async get(caseId: string): Promise<CaseState | undefined> {
    return (await this.store.get(caseId))?.state
  }

  async merge(
    caseId: string,
    input: {
      patch: Partial<CaseState>
      updateReason: string
      source: 'user' | 'llm' | 'tool' | 'system'
    },
  ): Promise<CaseState> {
    const result = await this.enqueue(caseId, async () => {
      const record = await this.store.get(caseId)
      if (!record) {
        throw new Error(`Case not found: ${caseId}`)
      }

      const { state, changedFields } = mergeCaseState(record.state, input.patch, input.source)
      const version = record.version + 1
      await this.store.save(caseId, state, version)

      this.traceLogger.logStateChange(caseId, {
        node: input.updateReason,
        stateBefore: record.state,
        statePatch: input.patch,
        stateAfter: state,
        stateDiff: buildFieldDiff(record.state, state, changedFields),
        reason: `${input.updateReason} (source=${input.source}, version=${version})`,
      })

      const output: CaseStateUpdateOutput = {
        caseId,
        updatedState: state,
        changedFields,
        version,
      }
      return output
    })

    return result.updatedState
  }

  async recordAskedQuestions(caseId: string, questions: FollowupQuestion[]): Promise<CaseState> {
    return this.merge(caseId, {
      patch: {
        askedQuestions: questions,
        status: 'waiting_user',
        meta: { followupRounds: ((await this.get(caseId))?.meta.followupRounds ?? 0) + 1 } as CaseState['meta'],
      },
      updateReason: 'asked_questions_recorded',
      source: 'system',
    })
  }

  private enqueue<T>(caseId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.mergeQueues.get(caseId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.mergeQueues.set(caseId, next.catch(() => undefined))
    return next
  }
}

/** 字段级 diff：标注哪个字段被改了、原值/新值、是否覆盖已有值、是否因空值丢失数据 */
function buildFieldDiff(before: CaseState, after: CaseState, changedFields: string[]): FieldDiff[] {
  return changedFields.map((field) => {
    const beforeValue = getByPath(before, field)
    const afterValue = getByPath(after, field)
    const hadValue = beforeValue !== undefined && beforeValue !== null && beforeValue !== '' &&
      !(Array.isArray(beforeValue) && beforeValue.length === 0)
    const nowEmpty = afterValue === undefined || afterValue === null || afterValue === '' ||
      (Array.isArray(afterValue) && afterValue.length === 0)
    return {
      field,
      before: beforeValue,
      after: afterValue,
      overwritten: hadValue && JSON.stringify(beforeValue) !== JSON.stringify(afterValue),
      droppedDueToEmpty: hadValue && nowEmpty,
    }
  })
}
