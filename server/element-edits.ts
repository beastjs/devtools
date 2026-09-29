import type { BeastDocument, BeastNode, ElementNode } from 'beast-tsrx'
import type { ElementEditRequest } from '../shared/types.js'
import { RefactorError } from './refactor.js'

function elements(nodes: readonly BeastNode[]): ElementNode[] {
  return nodes.flatMap((node): ElementNode[] => {
    switch (node.kind) {
      case 'element': return [node, ...elements(node.children)]
      case 'fragment': case 'scope': return elements(node.children)
      case 'if': case 'switch': return node.branches.flatMap((branch) => elements(branch.children))
      case 'each': return [...elements(node.children), ...elements(node.emptyChildren ?? [])]
      case 'try': return [...elements(node.children), ...elements(node.pendingBranch?.children ?? []), ...elements(node.catchBranch?.children ?? [])]
      default: return []
    }
  })
}

const BOOLEAN_ATTRIBUTES = new Set(['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected'])

const literal = (value: unknown) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** Rewrite only the selected element header; retain line positions for source tags. */
export function editElement(document: BeastDocument, source: string, request: ElementEditRequest): string {
  const all = [...elements(document.children), ...document.declarations.flatMap((d) => d.kind === 'component' ? elements(d.children) : [])]
  const node = all.find((n) => n.span.start.line === request.line && n.span.start.column === request.column)
  if (!node || node.isComponent || node.tag !== request.tag) throw new RefactorError('The source element changed. Pick it again.', 409)
  let attrs = node.attrs.map((attr) => source.slice(attr.span.start.offset, attr.span.end.offset).replace(/\r?\n[ \t]*~ ?/g, ' '))
  let classes = node.classes
  let id = node.id
  let text = node.inlineSpans?.map((span) => span.type === 'expr' ? `#{${span.code}}` : `#{${literal(span.text)}}`).join('') ?? ''
  const patches: Array<{ start: number; end: number; value: string }> = []
  const replaceAttr = (names: string[], code: string | null) => {
    attrs = attrs.filter((_, i) => { const a = node.attrs[i]; return !a || a.kind !== 'attribute' || !names.includes(a.name) })
    if (code !== null) attrs.push(code)
  }
  if (request.group === 'styles') {
    const attr = node.attrs.find((a) => a.kind === 'attribute' && a.name === 'style')
    let base = '{}'
    if (attr?.kind === 'attribute' && attr.value.type !== 'bool') {
      if (attr.value.type === 'string') {
        // A literal CSS string can be replaced with the browser-normalized declaration.
        if (attr.value.value.includes('#{')) throw new RefactorError('This style string contains expressions. Edit the full style attribute or use an object literal to preserve them.', 422)
        base = ''
      } else {
        const code = attr.value.code.trim()
        if (/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(code)) base = ''
        else if (code.startsWith('{') && code.endsWith('}')) base = code
        else throw new RefactorError('This style is computed outside the element. Edit the full style attribute or use an object literal to preserve its behavior.', 422)
      }
    }
    const declarations = request.declarations ?? {}
    if (Object.keys(declarations).length === 0) throw new RefactorError('No style changes supplied.', 422)
    for (const name of Object.keys(declarations)) if (!/^--[\w-]+$|^[a-zA-Z][\w-]*$/.test(name)) throw new RefactorError('Invalid CSS property.', 422)
    const overrides = Object.entries(declarations).map(([name, value]) => `${literal(name)}: ${literal(value ?? '')}`).join(', ')
    replaceAttr(['style'], base === '' ? `style={${literal(request.cssText ?? '')}}` : `style={{ ...(${base}), ${overrides} }}`)
  } else {
    const { name, value } = request
    if (!/^[a-zA-Z_][\w:.-]*$/.test(name) || /^on/i.test(name) || name.startsWith('data-beast-') || ['innerHTML', 'outerHTML', 'srcdoc'].includes(name)) throw new RefactorError('This property cannot be saved from the Elements panel.', 422)
    if (request.group === 'properties' && ['textContent', 'innerText'].includes(name)) {
      if (node.children.some((child) => child.kind !== 'text')) throw new RefactorError('Text edits cannot replace child elements.', 422)
      text = `#{${literal(value ?? '')}}`
      for (const child of node.children) patches.push({ start: child.span.start.offset, end: child.span.end.offset, value: (source.includes('\r\n') ? '\r\n' : '\n').repeat((source.slice(child.span.start.offset, child.span.end.offset).match(/\n/g) ?? []).length) })
    } else {
      const names = name === 'class' || name === 'className' ? ['class', 'className'] : [name, name.toLowerCase()]
      if (names.includes('class')) classes = []
      if (name === 'id') id = null
      const savedValue = request.group === 'attributes' && BOOLEAN_ATTRIBUTES.has(name.toLowerCase()) ? true : name === 'translate' && typeof value === 'boolean' ? (value ? 'yes' : 'no') : value
      replaceAttr(names, value === null ? null : `${name}={${literal(savedValue)}}`)
    }
  }
  const selector = `${node.tag}${id ? '#' + id : ''}${classes.map((name) => '.' + name).join('')}`
  const header = `${selector}${attrs.length ? '(' + attrs.join(' ') + ')' : ''}${text ? ' ' + text : ''}`
  const old = source.slice(node.span.start.offset, node.span.end.offset)
  patches.push({ start: node.span.start.offset, end: node.span.end.offset, value: header + (source.includes('\r\n') ? '\r\n' : '\n').repeat((old.match(/\n/g) ?? []).length) })
  for (const patch of patches.sort((a, b) => b.start - a.start)) source = source.slice(0, patch.start) + patch.value + source.slice(patch.end)
  return source
}
