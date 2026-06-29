// 工具注册表（设计文档 2.4）。主循环通过名字取工具；工具之间不互相调用。

import type { ToolName } from '../schemas/index.ts'
import type { ToolSpec } from '../agent/llm.ts'
import type { Tool } from './types.ts'
import { lookupRedFlagsTool } from './lookupRedFlags.ts'
import { askUserTool } from './askUser.ts'
import { updateRedFlagTool } from './updateRedFlag.ts'
import { generateReportTool } from './generateReport.ts'
import { extractFactsTool } from './extractFacts.ts'
import { addHypothesisTool } from './addHypothesis.ts'
import { updateHypothesisTool } from './updateHypothesis.ts'
import { searchMedicalTool } from './searchMedical.ts'

export type { Tool, ToolContext, ToolResult } from './types.ts'

export class ToolRegistry {
  private readonly tools = new Map<ToolName, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: ToolName): Tool | undefined {
    return this.tools.get(name)
  }

  /** 给 LLM 的工具清单（OpenAI 兼容 schema）。 */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec)
  }
}

/** M1 工具集：lookup_red_flags、ask_user、update_red_flag、generate_report。 */
export function createM1ToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(lookupRedFlagsTool as Tool)
  registry.register(askUserTool as Tool)
  registry.register(updateRedFlagTool as Tool)
  registry.register(generateReportTool as Tool)
  return registry
}

/** M3 工具集：M1 + extract_facts、add/update_hypothesis、search_medical。 */
export function createM3ToolRegistry(): ToolRegistry {
  const registry = createM1ToolRegistry()
  registry.register(extractFactsTool as Tool)
  registry.register(addHypothesisTool as Tool)
  registry.register(updateHypothesisTool as Tool)
  registry.register(searchMedicalTool as Tool)
  return registry
}
