import ts from 'typescript'
import type { BeastDocument, BeastNode } from 'beast-tsrx'

interface Token { variants: string; important: string; negative: string; utility: string }

// Variant colons inside arbitrary selectors/values are part of the token.
function tokenParts(token: string): Token {
  let depth = 0
  let split = 0
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '\\') { i++; continue }
    if (token[i] === '[' || token[i] === '(') depth++
    else if (token[i] === ']' || token[i] === ')') depth--
    else if (token[i] === ':' && depth === 0) split = i + 1
  }
  let utility = token.slice(split)
  const important = utility.startsWith('!') ? 'prefix' : utility.endsWith('!') ? 'suffix' : ''
  if (important === 'prefix') utility = utility.slice(1)
  if (important === 'suffix') utility = utility.slice(0, -1)
  const negative = utility.startsWith('-') ? '-' : ''
  if (negative) utility = utility.slice(1)
  return { variants: token.slice(0, split), important, negative, utility }
}

const render = (part: Token) => `${part.variants}${part.important === 'prefix' ? '!' : ''}${part.negative}${part.utility}${part.important === 'suffix' ? '!' : ''}`
const context = (part: Token) => `${part.variants}|${part.important}|${part.negative}`
const SPACING = /^(?:[pm](?:[trblxyse]|bs|be)?|scroll-[pm](?:[trblxyse]|bs|be)?|(?:min-|max-)?(?:w|h|size)|(?:min-|max-)?(?:inline|block)|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|start|end|translate(?:-[xyz])?|indent|leading|basis|border-spacing(?:-[xy])?)$/
const RADII: Record<number, string> = { 0: 'none', 2: 'xs', 4: 'sm', 6: 'md', 8: 'lg', 12: 'xl', 16: '2xl', 24: '3xl', 32: '4xl' }
const CORNERS: Record<string, string> = { '-tl': 'a', '-tr': 'b', '-bl': 'c', '-br': 'd', '-t': 'ab', '-b': 'cd', '-l': 'ac', '-r': 'bd' }

function normalizeUtility(part: Token): Token {
  const zIndex = /^z-\[(-?\d+)\]$/.exec(part.utility)
  if (zIndex) {
    const value = zIndex[1]!
    const negative = value.startsWith('-')
    return { ...part, negative: negative !== Boolean(part.negative) ? '-' : '', utility: `z-${negative ? value.slice(1) : value}` }
  }
  const match = /^(.+)-\[(?:length:)?(-?(?:\d+(?:\.\d+)?|\.\d+))px\]$/.exec(part.utility)
  if (!match) return part
  const [, prefix, raw] = match
  const value = Number(raw)
  if (/^rounded(?:-(?:tl|tr|bl|br|t|r|b|l|s|e|ss|se|es|ee))?$/.test(prefix!) && !part.negative && RADII[value] !== undefined) {
    return { ...part, utility: `${prefix}-${RADII[value]}` }
  }
  if (SPACING.test(prefix!)) {
    // Tailwind v4 accepts fractional multiples of its 4px spacing unit.
    if (value < 0 && part.negative) return part
    if ((value < 0 || part.negative) && !/^(?:m(?:[trblxyse]|bs|be)?|scroll-m(?:[trblxyse]|bs|be)?|inset(?:-[xy])?|top|right|bottom|left|start|end|translate(?:-[xyz])?|indent|space-[xy])$/.test(prefix!)) return part
    return { ...part, negative: value < 0 ? '-' : part.negative, utility: `${prefix}-${Math.abs(value) / 4}` }
  }
  // Border and outline widths use pixels directly, rather than --spacing.
  if (/^(?:border(?:-[trblxyse])?|outline|outline-offset|underline-offset|decoration)$/.test(prefix!) && Number.isInteger(value) && value >= 0) {
    return { ...part, utility: `${prefix}-${value}` }
  }
  return part
}

/** Collapse equal axes only when no other utility in that context overlaps them. */
function combine(parts: Token[]): Token[] {
  const families = [
    { family: 'p', sides: ['', 'x', 'y', 't', 'r', 'b', 'l', 's', 'e', 'bs', 'be'], pairs: [['r', 'l', 'x'], ['t', 'b', 'y'], ['x', 'y', '']] },
    { family: 'm', sides: ['', 'x', 'y', 't', 'r', 'b', 'l', 's', 'e', 'bs', 'be'], pairs: [['r', 'l', 'x'], ['t', 'b', 'y'], ['x', 'y', '']] },
    { family: 'gap', sides: ['', '-x', '-y'], pairs: [['-x', '-y', '']] },
    { family: 'rounded', sides: ['', '-tl', '-tr', '-bl', '-br', '-t', '-b', '-l', '-r', '-s', '-e', '-ss', '-se', '-es', '-ee'], pairs: [['-tl', '-tr', '-t'], ['-bl', '-br', '-b'], ['-tl', '-bl', '-l'], ['-tr', '-br', '-r'], ['-t', '-b', ''], ['-l', '-r', '']] },
  ]
  for (const { family, sides, pairs } of families) {
    const axes = (side: string) => family === 'rounded' ? CORNERS[side] ?? 'abcd' : side === 'x' || side === '-x' ? 'rl' : side === 'y' || side === '-y' ? 'tb' : side === '' ? 'trbl' : 'trbl'.includes(side) ? side : 'trbl'
    const orderedSides = [...sides].sort((a, b) => b.length - a.length)
    for (const [first, second, merged] of pairs) {
      for (let i = 0; i < parts.length; i++) {
        const a = parts[i]!
        if (!a.utility.startsWith(`${family}${first}-`)) continue
        const value = a.utility.slice(`${family}${first}-`.length)
        const j = parts.findIndex((b, index) => index !== i && context(a) === context(b) && b.utility === `${family}${second}-${value}`)
        if (j === -1) continue
        const overlaps = parts.some((b, index) => {
          if (index === i || index === j || a.variants !== b.variants || a.important !== b.important) return false
          if (b.utility === family) return true
          const side = orderedSides.find((side) => b.utility.startsWith(`${family}${side}-`))
          return side !== undefined && [...axes(side)].some((axis) => axes(merged!).includes(axis))
        })
        if (overlaps) continue
        parts[Math.min(i, j)] = { ...a, utility: `${family}${merged}-${value}` }
        parts.splice(Math.max(i, j), 1)
        i = -1
      }
    }
  }
  return parts
}

export function optimizeClassNames(value: string): string {
  return combine(value.split(/\s+/).filter(Boolean).map((token) => normalizeUtility(tokenParts(token)))).map(render).join(' ')
}

interface Patch { start: number; end: number; value: string }
function applyPatches(source: string, patches: Patch[]): string {
  for (const patch of patches.sort((a, b) => b.start - a.start)) source = source.slice(0, patch.start) + patch.value + source.slice(patch.end)
  return source
}

/** Visit class-producing expressions; leave tests, identifiers and unknown calls alone. */
function optimizeExpression(code: string): string {
  const prefix = 'const value = ('
  const file = ts.createSourceFile('classes.ts', `${prefix}${code});`, ts.ScriptTarget.Latest, true)
  const statement = file.statements[0]
  if (!statement || !ts.isVariableStatement(statement)) return code
  const patches: Patch[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.getText(file).includes('\n')) return
      const next = optimizeClassNames(node.text)
      if (next !== node.text) patches.push({ start: node.getStart(file) - prefix.length, end: node.end - prefix.length, value: JSON.stringify(next) })
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) visit(node.expression)
    else if (ts.isConditionalExpression(node)) { visit(node.whenTrue); visit(node.whenFalse) }
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) visit(node.right)
    else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['cx', 'cn', 'clsx', 'classnames', 'twMerge'].includes(node.expression.text)) node.arguments.forEach(visit)
    else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(visit)
    else if (ts.isObjectLiteralExpression(node)) {
      // Renaming keys must not collapse two conditional entries into one JS property.
      const keys = node.properties.flatMap((property) => property.name && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) ? [property.name.text] : [])
      const normalized = keys.map(optimizeClassNames)
      if (new Set(normalized).size === normalized.length && !node.properties.some((property) => ts.isSpreadAssignment(property) || property.name && ts.isComputedPropertyName(property.name))) {
        for (const property of node.properties) if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) visit(property.name)
      }
    }
  }
  const initializer = statement.declarationList.declarations[0]?.initializer
  if (initializer) visit(initializer)
  return applyPatches(code, patches)
}

/** Source spans keep setup code, styles, comments and other components untouched. */
export function optimizeTailwind(document: BeastDocument, source: string, host: string, defaultHost: string): string {
  const patches: Patch[] = []
  // Beast offsets count normalized LF input; line/column spans also work with CRLF.
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  const offset = (position: { line: number; column: number }) => starts[position.line - 1]! + position.column - 1
  const visit = (nodes: readonly BeastNode[]) => {
    for (const node of nodes) {
      if (node.kind === 'element') {
        for (const attr of node.attrs) {
          if (attr.kind !== 'attribute' || !['class', 'className'].includes(attr.name)) continue
          const start = offset(attr.span.start)
          const end = offset(attr.span.end)
          const raw = source.slice(start, end)
          let next = raw.replace(/^class\b/, 'className')
          if (attr.value.type === 'string' && !attr.value.value.includes('#{') && !raw.includes('\n')) {
            const value = optimizeClassNames(attr.value.value)
            if (value !== attr.value.value) next = `className={${JSON.stringify(value)}}`
          } else if (attr.value.type === 'expr') {
            const offset = next.indexOf('{') + 1
            const end = next.lastIndexOf('}')
            const code = next.slice(offset, end)
            const optimized = optimizeExpression(code)
            if (optimized !== code) {
              // Preserve continuation prefixes and line positions around the expression.
              next = next.slice(0, offset) + optimized + next.slice(end)
            }
          }
          if (next !== raw) patches.push({ start, end, value: next })
        }
        visit(node.children)
      } else if (node.kind === 'fragment' || node.kind === 'scope') visit(node.children)
      else if (node.kind === 'if' || node.kind === 'switch') node.branches.forEach((branch) => visit(branch.children))
      else if (node.kind === 'each') { visit(node.children); visit(node.emptyChildren ?? []) }
      else if (node.kind === 'try') { visit(node.children); visit(node.pendingBranch?.children ?? []); visit(node.catchBranch?.children ?? []) }
    }
  }
  const local = document.declarations.find((entry) => entry.kind === 'component' && entry.name === host)
  if (local?.kind === 'component') visit(local.children)
  else if (host === defaultHost) visit(document.children)
  return applyPatches(source, patches)
}
