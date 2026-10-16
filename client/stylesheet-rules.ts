import type { CssDeclaration, StylesheetFile, StylesheetRule } from '../shared/types.ts'

export interface InspectedCssRule {
  id: string
  selector: string
  context: string[]
  declarations: CssDeclaration[]
  active: boolean | null
  source: { path: string; hash: string; index: number; line: number; column: number } | null
  label: string
  inheritedFrom?: string
}

const INHERITED = new Set(['color', 'cursor', 'direction', 'visibility', 'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform', 'text-shadow', 'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'list-style', 'list-style-type', 'list-style-position', 'list-style-image', 'border-collapse', 'border-spacing', 'caption-side', 'empty-cells', 'quotes', 'writing-mode', 'text-orientation', 'tab-size', 'accent-color', 'color-scheme', '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width'])
const inherited = (name: string) => name.startsWith('--') || INHERITED.has(name) || name.startsWith('font-')

interface SourceRule {
  file: StylesheetFile
  rule: StylesheetRule
  selectorKey?: string
  declarationKey?: string
}
const sourceCache = new WeakMap<StylesheetFile, { document: Document; rules: SourceRule[] }>()

/** Split selector lists without splitting :is(), attribute values, or escaped commas. */
export function splitSelectors(selector: string): string[] {
  const result: string[] = []
  let start = 0, depth = 0, quote = ''
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!
    if (char === '\\') { i++; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '[' || char === '(') depth++
    else if (char === ']' || char === ')') depth--
    else if (char === ',' && depth === 0) { result.push(selector.slice(start, i).trim()); start = i + 1 }
  }
  result.push(selector.slice(start).trim())
  return result
}

export function nestedSelector(selector: string, parent?: string): string {
  if (!parent) return selector
  return splitSelectors(selector).map((part) => {
    let expanded = '', quote = '', attribute = false, replaced = false
    for (let i = 0; i < part.length; i++) {
      const char = part[i]!
      if (char === '\\') { expanded += part.slice(i, i + 2); i++; continue }
      if (quote) { expanded += char; if (char === quote) quote = ''; continue }
      if (char === '"' || char === "'") quote = char
      if (char === '[') attribute = true
      if (char === ']') attribute = false
      if (char === '&' && !attribute && !quote) { expanded += `:is(${parent})`; replaced = true }
      else expanded += char
    }
    return replaced ? expanded : `:is(${parent}) ${expanded}`
  }).join(', ')
}

export function fileRule(file: StylesheetFile, rule: StylesheetRule): InspectedCssRule {
  return {
    id: `${file.path}:${rule.index}`, selector: rule.selector,
    context: rule.context.map(({ name, params }) => name === 'nest' ? params : `@${name} ${params}`),
    declarations: rule.declarations, active: null,
    source: { path: file.path, hash: file.hash, index: rule.index, line: rule.line, column: rule.column }, label: file.path,
  }
}

const contextKey = (context: StylesheetRule['context']) => JSON.stringify(context.map(({ name, params }) => [name, params.replace(/\s+/g, '')]))

/** Map the browser's matching rules back to authored files; unmatched runtime CSS stays read-only. */
export function inspectStylesheets(element: Element, files: readonly StylesheetFile[]): { rules: InspectedCssRule[]; warnings: string[] } {
  const doc = element.ownerDocument
  const view = doc.defaultView!
  const probe = doc.createElement('span').style
  const selectorProbe = new view.CSSStyleSheet()
  const selectors = new Map<string, string>()
  const selectorKey = (selector: string) => {
    let normalized = selectors.get(selector)
    if (normalized !== undefined) return normalized
    try { selectorProbe.replaceSync(`${selector} {}`); normalized = (selectorProbe.cssRules[0] as CSSStyleRule)?.selectorText ?? selector }
    catch { normalized = selector }
    selectors.set(selector, normalized)
    return normalized
  }
  const declarationKey = (declarations: CssDeclaration[]) => {
    probe.cssText = ''
    for (const { name, value } of declarations) probe.setProperty(name, value.replace(/\s*!important\s*$/i, ''), /\s*!important\s*$/i.test(value) ? 'important' : '')
    return Array.from(probe).sort().map((name) => `${name}:${probe.getPropertyValue(name)}!${probe.getPropertyPriority(name)}`).join(';')
  }
  const candidates = files.flatMap((file) => {
    let cached = sourceCache.get(file)
    if (!cached || cached.document !== doc) {
      cached = { document: doc, rules: file.rules.filter((rule) => !rule.context.some((context) => /keyframes$/i.test(context.name))).map((rule) => ({ file, rule })) }
      sourceCache.set(file, cached)
    }
    return cached.rules
  })
  const sourceSelector = (candidate: SourceRule) => candidate.selectorKey ??= selectorKey(candidate.rule.selector)
  const sourceDeclarations = (candidate: SourceRule) => candidate.declarationKey ??= declarationKey(candidate.rule.declarations)
  const rules: InspectedCssRule[] = [], warnings: string[] = []
  const seen = new Set<string>(), visited = new Set<CSSStyleSheet>()
  const matches = (target: Element, selector: string) => { try { return target.matches(selector) } catch { return false } }
  const combine = (parent: boolean | null, next: boolean | null) => parent === false || next === false ? false : parent === null || next === null ? null : true
  const mediaActive = (media: string) => !media || view.matchMedia(media).matches
  const visitSheet = (sheet: CSSStyleSheet, active: boolean | null = true, importedHref?: string) => {
    if (visited.has(sheet)) return
    visited.add(sheet)
    const owner = sheet.ownerNode instanceof Element ? sheet.ownerNode : null
    const href = importedHref ?? sheet.href ?? owner?.getAttribute('data-vite-dev-id') ?? ''
    const label = href || (owner?.id ? `style#${owner.id}` : 'Inline or generated stylesheet')
    let pathname = href
    try { pathname = decodeURIComponent(new URL(href, doc.baseURI).pathname) } catch { /* Keep the original source label. */ }
    const hinted = files.filter((file) => pathname === '/' + file.path || pathname.endsWith('/' + file.path) || (file.path.startsWith('public/') && pathname === '/' + file.path.slice(7)))
    const local = !href || href.startsWith('/') || (() => { try { return new URL(href, doc.baseURI).origin === view.location.origin } catch { return false } })()
    const pool = hinted.length ? candidates.filter(({ file }) => hinted.includes(file)) : local ? candidates : []
    let list: CSSRuleList
    try { list = sheet.cssRules } catch { warnings.push(`Cannot inspect ${label}: the browser does not allow access to its rules.`); return }
    const walk = (list: CSSRuleList, context: StylesheetRule['context'], active: boolean | null, parentSelector?: string) => {
      for (const cssRule of Array.from(list)) {
        if (cssRule.type === 7) continue // @keyframes
        if (cssRule.type === 3) {
          const imported = cssRule as CSSImportRule
          const supports = !imported.supportsText || view.CSS.supports(imported.supportsText) || view.CSS.supports(`(${imported.supportsText})`)
          if (imported.styleSheet) visitSheet(imported.styleSheet, combine(active, mediaActive(imported.media.mediaText) && supports), imported.href)
          continue
        }
        if ('selectorText' in cssRule && 'style' in cssRule) {
          const rule = cssRule as CSSStyleRule
          const selector = nestedSelector(rule.selectorText, parentSelector)
          let target: Element | null = element
          if (!matches(element, selector)) {
            target = Array.from(rule.style).some(inherited) ? element.parentElement : null
            while (target && !matches(target, selector)) target = target.parentElement
          }
          if (target && rule.style.length) {
            const declarations = Array.from(rule.style, (name) => ({ name, value: `${rule.style.getPropertyValue(name)}${rule.style.getPropertyPriority(name) ? ' !important' : ''}` }))
            const selectorId = selectorKey(rule.selectorText), key = declarationKey(declarations)
            const matching = pool.filter((candidate) => sourceSelector(candidate) === selectorId && contextKey(candidate.rule.context) === contextKey(context) && sourceDeclarations(candidate) === key)
            let source = matching.length === 1 ? matching[0] : undefined
            if (!source && hinted.length) {
              // CSS modules may rewrite class selectors; require a unique declaration block in the known file.
              const exact = pool.filter((candidate) => candidate.file.path.endsWith('.module.css') && contextKey(candidate.rule.context) === contextKey(context) && sourceDeclarations(candidate) === key)
              if (exact.length === 1) source = exact[0]
            }
            if (!source && local) {
              // Bundlers can flatten @import files into their importer's stylesheet.
              const exact = candidates.filter((candidate) => sourceSelector(candidate) === selectorId && sourceDeclarations(candidate) === key)
              const contextual = exact.filter((candidate) => contextKey(candidate.rule.context) === contextKey(context))
              if (contextual.length === 1) source = contextual[0]
              else if (exact.length === 1) source = exact[0]
            }
            const entry: InspectedCssRule = source ? { ...fileRule(source.file, source.rule), active }
              : { id: `${label}:${rules.length}:${selector}`, selector: rule.selectorText, context: context.map(({ name, params }) => name === 'nest' ? params : `@${name} ${params}`), declarations, active, source: null, label }
            if (target !== element) {
              entry.inheritedFrom = `${target.localName}${target.id ? '#' + target.id : ''}${Array.from(target.classList).map((name) => '.' + name).join('')}`
              entry.declarations = entry.declarations.filter((declaration) => inherited(declaration.name))
            }
            if (!seen.has(entry.id)) { seen.add(entry.id); rules.push(entry) }
          }
          if ('cssRules' in rule) walk(rule.cssRules, [...context, { name: 'nest', params: rule.selectorText }], active, selector)
        } else if ('cssRules' in cssRule) {
          const header = cssRule.cssText.slice(0, cssRule.cssText.indexOf('{')).trim()
          const [, name = '', params = ''] = /^@([\w-]+)\s*([\s\S]*)$/.exec(header) ?? []
          let condition: boolean | null = true
          if (name === 'media') condition = mediaActive(params)
          else if (name === 'supports') condition = view.CSS.supports(params)
          else if (name !== 'layer') condition = null // Container/scope conditions cannot be evaluated with matchMedia.
          walk((cssRule as CSSGroupingRule).cssRules, [...context, { name, params }], combine(active, condition), parentSelector)
        }
      }
    }
    walk(list, [], combine(active, !sheet.disabled && mediaActive(sheet.media.mediaText)))
  }
  const root = element.getRootNode() as Document | ShadowRoot
  for (const sheet of [...Array.from(root.styleSheets ?? []), ...Array.from(root.adoptedStyleSheets ?? [])]) visitSheet(sheet)
  return { rules, warnings }
}
