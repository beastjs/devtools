import type { BeastSourceMap } from 'beast-tsrx'

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGITS = new Map([...BASE64].map((char, index) => [char, index]))

export interface LineMap {
  tsrxToBtsx: Array<number | null>
  btsxToTsrx: number[][]
}

/**
 * Collapse Beast's node-level v3 source map into 1-based line correspondences
 * in both directions. Beast emits a single source per map, so the source index
 * is tracked only to keep the VLQ state machine correct.
 */
export function buildLineMap(map: BeastSourceMap, generatedLineCount: number, sourceLineCount: number): LineMap {
  const tsrxToBtsx: Array<number | null> = Array.from({ length: generatedLineCount }, () => null)
  const btsxToTsrx: number[][] = Array.from({ length: sourceLineCount }, () => [])

  let sourceIndex = 0
  let sourceLine = 0
  let sourceColumn = 0
  const lines = map.mappings.split(';')

  for (let generated = 0; generated < lines.length; generated++) {
    const line = lines[generated]
    if (line === undefined || line === '') continue
    for (const segment of line.split(',')) {
      const fields = decodeVlq(segment)
      if (fields.length < 4) continue
      sourceIndex += fields[1]!
      sourceLine += fields[2]!
      sourceColumn += fields[3]!
      if (sourceIndex !== 0 || generated >= generatedLineCount) continue
      const btsxLine = sourceLine + 1
      tsrxToBtsx[generated] ??= btsxLine
      const targets = btsxToTsrx[sourceLine]
      if (targets !== undefined && targets.at(-1) !== generated + 1) targets.push(generated + 1)
    }
  }

  void sourceColumn
  return { tsrxToBtsx, btsxToTsrx }
}

function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = DIGITS.get(char)
    if (digit === undefined) return values
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      continue
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return values
}
