import ts from 'typescript'
import type { BeastDocument, BeastNode, ElementNode } from 'beast-tsrx'
import { RefactorError } from './refactor.js'

function isEmptyStyle(attr: ElementNode['attrs'][number]): boolean {
  if (attr.kind !== 'attribute' || attr.name !== 'style') return false
  if (attr.value.type === 'string') return attr.value.value.trim() === ''
  if (attr.value.type !== 'expr') return false
  const file = ts.createSourceFile('style.ts', `const value = (${attr.value.code});`, ts.ScriptTarget.Latest, true)
  const statement = file.statements[0]
  let value = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined
  while (value && ts.isParenthesizedExpression(value)) value = value.expression
  return !!value && (ts.isObjectLiteralExpression(value) && value.properties.length === 0 || ts.isStringLiteral(value) && value.text.trim() === '')
}

interface EmptyStyleEdit {
  start: number
  end: number
  replacement: string
  usage: string
}

/** Only remove statically empty native styles; preserve every unrelated source byte. */
export function emptyStyleEdits(document: BeastDocument, source: string): Map<string, EmptyStyleEdit> {
  const edits = new Map<string, EmptyStyleEdit>()
  // Beast offsets use normalized newlines; line/column positions retain CRLF source bytes.
  const lineOffsets = [0]
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') lineOffsets.push(index + 1)
  const offset = (point: { line: number; column: number }) => lineOffsets[point.line - 1]! + point.column - 1
  const visit = (nodes: readonly BeastNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'element') {
        const empty = node.isComponent ? [] : node.attrs.filter(isEmptyStyle)
        if (empty.length) {
          const start = offset(node.span.start)
          const end = offset(node.span.end)
          let replacement = source.slice(start, end)
          if (empty.length === node.attrs.length) {
            const first = empty[0]!
            const last = empty.at(-1)!
            const open = source.lastIndexOf('(', offset(first.span.start))
            const closing = /^(?:\s|~)*\)/.exec(source.slice(offset(last.span.end), end))
            if (open >= start && closing) replacement = source.slice(start, open) + source.slice(offset(last.span.end) + closing[0].length, end)
          } else {
            for (const attr of [...empty].reverse()) {
              let from = offset(attr.span.start) - start
              let to = offset(attr.span.end) - start
              const lineStart = replacement.lastIndexOf('\n', from - 1) + 1
              const lineEnd = replacement.indexOf('\n', to)
              const prefix = replacement.slice(lineStart, from)
              const suffix = replacement.slice(to, lineEnd < 0 ? replacement.length : lineEnd)
              if (/^[ \t]*~[ \t]*$/.test(prefix) && /^[ \t\r]*$/.test(suffix)) {
                from = lineStart
                to = lineEnd < 0 ? replacement.length : lineEnd + 1
              } else {
                while (from > 0 && /[ \t,]/.test(replacement[from - 1]!)) from--
                if (replacement[from - 1] === '(' || replacement[from - 1] === '~') while (/[ \t,]/.test(replacement[to] ?? 'x')) to++
              }
              replacement = replacement.slice(0, from) + replacement.slice(to)
            }
          }
          if (replacement !== source.slice(start, end)) {
            const indent = ' '.repeat(node.span.start.column - 1)
            edits.set(`${node.span.start.line}:${node.span.start.column}`, { start, end, replacement, usage: indent + replacement })
          }
        }
        visit(node.children)
      } else if (node.kind === 'fragment' || node.kind === 'scope') visit(node.children)
      else if (node.kind === 'if' || node.kind === 'switch') node.branches.forEach((branch) => visit(branch.children))
      else if (node.kind === 'each') { visit(node.children); visit(node.emptyChildren ?? []) }
      else if (node.kind === 'try') { visit(node.children); visit(node.pendingBranch?.children ?? []); visit(node.catchBranch?.children ?? []) }
    }
  }
  visit(document.children)
  for (const declaration of document.declarations) if (declaration.kind === 'component') visit(declaration.children)
  return edits
}

export function removeEmptyStyles(document: BeastDocument, source: string, location: string): string {
  const edit = emptyStyleEdits(document, source).get(location)
  if (!edit) throw new RefactorError('This element no longer has an empty style attribute.', 422)
  return source.slice(0, edit.start) + edit.replacement + source.slice(edit.end)
}
