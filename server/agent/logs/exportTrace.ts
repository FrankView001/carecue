// Trace 导出 CLI：npm run trace:export -- <traceId>
// 读取 {TRACE_LOG_DIR}/{traceId}.jsonl，整理为单个 JSON 数组文件 trace-{traceId}.json

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { traceLogDir } from './traceLogger.ts'

const traceId = process.argv[2]
if (!traceId) {
  console.error('用法: npm run trace:export -- <traceId>')
  process.exit(1)
}

const inputFile = join(traceLogDir(), `${traceId}.jsonl`)
const outputFile = `trace-${traceId}.json`

try {
  const lines = readFileSync(inputFile, 'utf8').split('\n').filter((line) => line.trim().length > 0)
  const events = lines.map((line) => JSON.parse(line))
  writeFileSync(outputFile, JSON.stringify(events, null, 2), 'utf8')
  console.log(`已导出 ${events.length} 条事件 -> ${outputFile}`)
} catch (err) {
  console.error(`导出失败：找不到或无法解析 ${inputFile}`)
  console.error(String(err))
  process.exit(1)
}
