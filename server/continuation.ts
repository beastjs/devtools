import type { BeastDocument, BeastNode } from 'beast-tsrx'
import { RefactorError } from './refactor.js'

/** Preserve attribute source verbatim, including expressions and spreads. */
export function continuationEdits(document: BeastDocument, source: string): Map<number, string> {
  const edits = new Map<number, string>()
  const lines = source.split('\n')
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const indents = lines.filter((line) => line.trim() !== '').map((line) => /^ */.exec(line)![0].length).filter(Boolean)
  const step = ' '.repeat(Math.min(...indents, 2))
  const visit = (nodes: readonly BeastNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'element') {
        const line = node.span.start.line
        const attrs = node.attrs
        const raw = lines[line - 1]!.replace(/\r$/, '')
        const start = node.span.start.column - 1
        const open = raw.indexOf('(', start)
        const last = attrs.at(-1)
        if (last && open >= start && open < attrs[0]!.span.start.column - 1 &&
            attrs.every((attr) => attr.span.start.line === line && attr.span.end.line === line)) {
          const end = last.span.end.column - 1
          const close = end + (/^\s*/.exec(raw.slice(end))?.[0].length ?? 0)
          if (raw[close] === ')' && close < raw.length &&
              !lines[line]?.trimStart().startsWith('~')) {
            const indent = /^\s*/.exec(raw)![0] + step
            const header = raw.slice(0, open + 1)
            const props = attrs.map((attr) => `${indent}~ ${raw.slice(attr.span.start.column - 1, attr.span.end.column - 1).trim()}`)
            const tail = raw.slice(close)
            edits.set(line, [header, ...props, `${indent}~ ${tail}`].join(newline))
          }
        }
        visit(node.children)
      } else if (node.kind === 'fragment' || node.kind === 'scope') visit(node.children)
      else if (node.kind === 'if' || node.kind === 'switch') node.branches.forEach((branch) => visit(branch.children))
      else if (node.kind === 'each') { visit(node.children); visit(node.emptyChildren ?? []) }
      else if (node.kind === 'try') {
        visit(node.children)
        visit(node.pendingBranch?.children ?? [])
        visit(node.catchBranch?.children ?? [])
      }
    }
  }
  visit(document.children)
  for (const declaration of document.declarations) if (declaration.kind === 'component') visit(declaration.children)
  return edits
}

export function continueProps(document: BeastDocument, source: string, line: number): string {
  const replacement = continuationEdits(document, source).get(line)
  if (replacement === undefined) throw new RefactorError('Select a component or element with inline props to continue.', 422)
  const lines = source.split('\n')
  lines[line - 1] = replacement + (lines[line - 1]!.endsWith('\r') ? '\r' : '')
  return lines.join('\n')
}
