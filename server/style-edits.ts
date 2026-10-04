import ts from 'typescript'
import postcss from 'postcss'
import { twMerge } from 'tailwind-merge'
import { RefactorError } from './refactor.js'

const literal = (value: string) => JSON.stringify(value)
const cssName = (name: string) => name.startsWith('--') ? name : name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

export function literalString(code: string): string | null {
  const file = ts.createSourceFile('literal.ts', `const value = (${code});`, ts.ScriptTarget.Latest, true)
  const statement = file.statements[0]
  const init = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined
  const expression = init && ts.isParenthesizedExpression(init) ? init.expression : init
  return expression && ts.isStringLiteral(expression) ? expression.text : null
}

export function removeStyleString(source: string, names: string[]): string {
  const root = postcss.parse(`a { ${source} }`)
  const rule = root.first
  if (rule?.type !== 'rule' || root.nodes.length !== 1 || rule.nodes.some((node) => node.type !== 'decl' && node.type !== 'comment')) throw new RefactorError('Use a declaration string for inline styles.', 422)
  rule.walkDecls((decl) => { if (names.includes(decl.prop)) decl.remove() })
  return rule.nodes.map((node) => node.toString() + (node.type === 'decl' ? ';' : '')).join(' ')
}

/** Replace explicit object members, including camelCase aliases, without nesting spreads. */
export function replaceStyleObject(code: string, declarations: Record<string, string | null>): string {
  const file = ts.createSourceFile('style.ts', `const style = (${code});`, ts.ScriptTarget.Latest, true)
  const statement = file.statements[0]
  const init = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined
  const object = init && ts.isParenthesizedExpression(init) ? init.expression : init
  if (!object || !ts.isObjectLiteralExpression(object)) throw new RefactorError('Use an object literal to edit individual styles.', 422)
  const names = new Set(Object.keys(declarations))
  const members: string[] = []
  const visit = (object: ts.ObjectLiteralExpression) => {
    for (const member of object.properties) {
      // Flatten the wrappers emitted by older versions of the Elements panel.
      if (ts.isSpreadAssignment(member) && ts.isParenthesizedExpression(member.expression) && ts.isObjectLiteralExpression(member.expression.expression)) {
        visit(member.expression.expression)
        continue
      }
      if (ts.isSpreadAssignment(member) && Object.values(declarations).some((value) => value === null || !value.trim())) throw new RefactorError('Cannot remove styles supplied by a computed spread. Edit that style object in source.', 422)
      const rawName = member.name
      const name = rawName && ts.isComputedPropertyName(rawName) ? rawName.expression : rawName
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) && names.has(cssName(name.text))) continue
      members.push(member.getText(file))
    }
  }
  visit(object)
  const retained = members.join(', ')
  const replacements = Object.entries(declarations).filter(([, value]) => value !== null && value.trim() !== '').map(([name, value]) => `${literal(name)}: ${literal(value!)}`)
  return `{ ${[retained, ...replacements].filter(Boolean).join(', ')} }`
}

/** Edit an existing rule; refuse ambiguous selectors rather than modifying conditional rules. */
export function replaceCssRule(source: string, selector: string, declarations: Record<string, string | null>): string {
  const root = postcss.parse(source)
  const matches: postcss.Rule[] = []
  root.walkRules((rule) => { if (rule.selector === selector) matches.push(rule) })
  if (matches.length !== 1) throw new RefactorError(matches.length ? 'This selector occurs more than once. Choose a unique CSS rule.' : 'No CSS rule matches this selector in the selected file.', 422)
  const rule = matches[0]!
  for (const [name, value] of Object.entries(declarations)) {
    const existing: postcss.Declaration[] = []
    rule.each((node) => { if (node.type === 'decl' && node.prop === name) existing.push(node) })
    if (value === null || !value.trim()) { existing.forEach((node) => node.remove()); continue }
    const important = /\s*!important\s*$/i.test(value)
    const next = value.replace(/\s*!important\s*$/i, '').trim()
    const parsed = postcss.parse(`a { ${name}: ${next}${important ? ' !important' : ''}; }`)
    const parsedRule = parsed.first
    if (parsed.nodes.length !== 1 || parsedRule?.type !== 'rule' || parsedRule.nodes.length !== 1 || parsedRule.first?.type !== 'decl' || parsedRule.first.prop !== name) throw new RefactorError('Invalid CSS declaration.', 422)
    const last = existing.pop()
    existing.forEach((node) => node.remove())
    if (last) { last.value = next; last.important = important }
    else rule.append({ prop: name, value: next, important })
  }
  return root.toString()
}

const utilities: Record<string, string> = {
  width: 'w', height: 'h', 'min-width': 'min-w', 'max-width': 'max-w', 'min-height': 'min-h', 'max-height': 'max-h',
  padding: 'p', 'padding-top': 'pt', 'padding-right': 'pr', 'padding-bottom': 'pb', 'padding-left': 'pl',
  margin: 'm', 'margin-top': 'mt', 'margin-right': 'mr', 'margin-bottom': 'mb', 'margin-left': 'ml',
  gap: 'gap', 'row-gap': 'gap-y', 'column-gap': 'gap-x', 'font-size': 'text', 'font-weight': 'font',
  color: 'text', 'background-color': 'bg', 'line-height': 'leading', 'border-radius': 'rounded', opacity: 'opacity',
  'flex-grow': 'grow', 'flex-shrink': 'shrink', 'align-items': 'items', 'align-content': 'content',
  'justify-content': 'justify', 'grid-template-columns': 'grid-cols', 'grid-template-rows': 'grid-rows',
  top: 'top', right: 'right', bottom: 'bottom', left: 'left', 'z-index': 'z', overflow: 'overflow', 'box-shadow': 'shadow',
  'border-width': 'border', 'border-color': 'border', 'border-style': 'border',
}

const enumUtilities: Record<string, Record<string, string>> = {
  display: { block: 'block', inline: 'inline', 'inline-block': 'inline-block', flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-grid': 'inline-grid', contents: 'contents', none: 'hidden', table: 'table', 'flow-root': 'flow-root' },
  position: { static: 'static', fixed: 'fixed', absolute: 'absolute', relative: 'relative', sticky: 'sticky' },
  'flex-direction': { row: 'flex-row', 'row-reverse': 'flex-row-reverse', column: 'flex-col', 'column-reverse': 'flex-col-reverse' },
  'flex-wrap': { wrap: 'flex-wrap', 'wrap-reverse': 'flex-wrap-reverse', nowrap: 'flex-nowrap' },
  'align-items': { 'flex-start': 'items-start', 'flex-end': 'items-end', center: 'items-center', baseline: 'items-baseline', stretch: 'items-stretch' },
  'align-content': { 'flex-start': 'content-start', 'flex-end': 'content-end', center: 'content-center', 'space-between': 'content-between', 'space-around': 'content-around', 'space-evenly': 'content-evenly', stretch: 'content-stretch', baseline: 'content-baseline', normal: 'content-normal' },
  'justify-content': { 'flex-start': 'justify-start', 'flex-end': 'justify-end', center: 'justify-center', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly', stretch: 'justify-stretch', normal: 'justify-normal' },
  overflow: { auto: 'overflow-auto', hidden: 'overflow-hidden', clip: 'overflow-clip', visible: 'overflow-visible', scroll: 'overflow-scroll' },
  'border-style': { solid: 'border-solid', dashed: 'border-dashed', dotted: 'border-dotted', double: 'border-double', hidden: 'border-hidden', none: 'border-none' },
}

function utility(name: string, encoded: string): string {
  const enums = enumUtilities[name]
  if (enums) return enums[encoded] ?? `[${name}:${encoded}]`
  const prefix = utilities[name]
  const hint = ['color', 'background-color', 'border-color'].includes(name) ? 'color:' : ['font-size', 'border-width'].includes(name) ? 'length:' : ''
  return prefix ? `${prefix}-[${hint}${encoded}]` : `[${name}:${encoded}]`
}

/** Use Tailwind's utility groups to distinguish color, size, family, images and variants. */
export function replaceTailwindClasses(classes: string[], declarations: Record<string, string | null>): string[] {
  let next = [...classes]
  for (const [name, value] of Object.entries(declarations)) {
    if (name === 'width' || name === 'height') {
      next = next.map((token) => token.startsWith('size-') ? `${name === 'width' ? 'h' : 'w'}-${token.slice(5)}` : token)
    }
    // Split spacing shorthands so editing one side preserves the other three.
    const side = /^(padding|margin)-(top|right|bottom|left)$/.exec(name)
    if (side) {
      const family = side[1] === 'padding' ? 'p' : 'm'
      const edited = { top: 't', right: 'r', bottom: 'b', left: 'l' }[side[2]!]!
      next = next.flatMap((token) => {
        const match = new RegExp(`^(-?)(${family}|${family}x|${family}y)-(.+)$`).exec(token)
        if (!match) return [token]
        const sides = match[2] === family ? ['t', 'r', 'b', 'l'] : match[2] === family + 'x' ? ['r', 'l'] : ['t', 'b']
        if (!sides.includes(edited)) return [token]
        return sides.filter((s) => s !== edited).map((s) => `${match[1]}${family}${s}-${match[3]}`)
      })
    }
    // An arbitrary property emitted by an older save belongs to the same group.
    next = next.filter((token) => !token.replace(/^!/, '').replace(/!$/, '').startsWith(`[${name}:`))
    const marker = enumUtilities[name] ? Object.values(enumUtilities[name]!)[0]! : utility(name, '0')
    next = next.filter((token) => {
      const plain = token.replace(/^!/, '').replace(/!$/, '')
      return plain !== marker && twMerge(plain, marker).split(' ').includes(plain)
    })
    if (value !== null && value.trim()) {
      if (/[\[\]\r\n]/.test(value)) throw new RefactorError('This value cannot be represented as a Tailwind arbitrary value.', 422)
      const important = /\s*!important\s*$/i.test(value)
      const encoded = value.replace(/\s*!important\s*$/i, '').trim().replace(/[\\_]/g, '\\$&').replace(/\s/g, '_')
      next.push(`${important ? '!' : ''}${utility(name, encoded)}`)
    }
  }
  return next
}
