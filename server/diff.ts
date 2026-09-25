import type { DiffHunk, DiffLine } from '../shared/types.js'

export interface LineDiff {
  added: number
  removed: number
  hunks: DiffHunk[]
}

/**
 * Line diff for refactor previews. Edits are localized, so the common prefix
 * and suffix are trimmed before an LCS pass over the changed middle.
 */
export function diffLines(before: readonly string[], after: readonly string[], context = 2): LineDiff {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++

  const a = before.slice(prefix, before.length - suffix)
  const b = after.slice(prefix, after.length - suffix)
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  // Every line of both files, tagged, with 1-based positions for hunk headers.
  const ops: Array<DiffLine & { oldLine: number; newLine: number }> = []
  for (let k = 0; k < prefix; k++) ops.push({ type: 'context', text: before[k]!, oldLine: k + 1, newLine: k + 1 })
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ type: 'context', text: a[i]!, oldLine: prefix + i + 1, newLine: prefix + j + 1 })
      i++
      j++
    } else if (j < b.length && (i === a.length || table[i]![j + 1]! > table[i + 1]![j]!)) {
      ops.push({ type: 'add', text: b[j]!, oldLine: prefix + i + 1, newLine: prefix + j + 1 })
      j++
    } else {
      ops.push({ type: 'remove', text: a[i]!, oldLine: prefix + i + 1, newLine: prefix + j + 1 })
      i++
    }
  }
  for (let k = 0; k < suffix; k++) {
    ops.push({
      type: 'context',
      text: before[before.length - suffix + k]!,
      oldLine: before.length - suffix + k + 1,
      newLine: after.length - suffix + k + 1,
    })
  }

  // Group changes separated by at most 2 × context unchanged lines, then pad each group.
  const changes = ops.flatMap((op, index) => (op.type === 'context' ? [] : [index]))
  const groups: Array<[number, number]> = []
  for (const index of changes) {
    const last = groups.at(-1)
    if (last !== undefined && index - last[1] <= context * 2 + 1) last[1] = index
    else groups.push([index, index])
  }
  const hunks: DiffHunk[] = groups.map(([first, last]) => {
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, last + context)
    return {
      oldStart: ops[from]!.oldLine,
      newStart: ops[from]!.newLine,
      lines: ops.slice(from, to + 1).map(({ type, text }) => ({ type, text })),
    }
  })

  return {
    added: ops.filter((op) => op.type === 'add').length,
    removed: ops.filter((op) => op.type === 'remove').length,
    hunks,
  }
}
