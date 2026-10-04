import { highlight, type Language, type Token } from './highlight.ts'

export interface ClassRange { from: number; to: number; text: string; keywordFrom: number; keywordTo: number }
export interface DisplayToken extends Token { classFold?: ClassRange; classKeyword?: number }

/** Literal contents of class/className attributes; expressions and quote delimiters stay visible. */
export function classRanges(source: string, language: Language): ClassRange[] {
  const ranges: ClassRange[] = []
  const seen = new Set<number>()
  let keywordFrom = 0, keywordTo = 0
  const quoted = (start: number) => {
    const quote = source[start]!
    let end = start + 1
    for (; end < source.length; end++) {
      if (source[end] === '\\') end++
      else if (source[end] === quote) break
    }
    if (end < source.length && end > start + 1 && !seen.has(start) && !(quote === '`' && source.slice(start + 1, end).includes('${'))) {
      seen.add(start)
      const text = source.slice(start + 1, end)
      if (text.trim()) ranges.push({ from: start + 1, to: end, text, keywordFrom, keywordTo })
    }
    return end + 1
  }
  const value = (start: number) => {
    let at = start
    while (/\s/.test(source[at] ?? '') && at < source.length) at++
    if (source[at++] !== '=') return
    while (/\s/.test(source[at] ?? '') && at < source.length) at++
    if (/['"`]/.test(source[at] ?? '')) { quoted(at); return }
    if (source[at] !== '{') return
    let depth = 0
    while (at < source.length) {
      const char = source[at]!
      if (/['"`]/.test(char)) { at = quoted(at); continue }
      if (source.startsWith('//', at)) { at = source.indexOf('\n', at); if (at === -1) break; continue }
      if (source.startsWith('/*', at)) { const end = source.indexOf('*/', at + 2); if (end === -1) break; at = end + 2; continue }
      if (char === '{') depth++
      if (char === '}' && --depth === 0) break
      at++
    }
  }
  let position = 0, inTag = false
  for (const tokens of highlight(source, language)) {
    for (const token of tokens) {
      if (language === 'tsrx' && (token.type === 'tag' || token.type === 'component')) {
        if (token.value.startsWith('<')) inTag = true
        if (token.value.endsWith('>')) inTag = false
      }
      if (token.type === 'attr' && /^(class|className)$/.test(token.value) && (language === 'btsx' || inTag)) {
        keywordFrom = position; keywordTo = position + token.value.length
        value(keywordTo)
      }
      position += token.value.length
    }
    position++
  }
  return ranges.sort((a, b) => a.from - b.from)
}

/** Toggle all literal branches of one attribute, preserving other attributes' overrides. */
export function toggleClassOverrides(ranges: readonly ClassRange[], collapsed: boolean, overrides: ReadonlyMap<number, boolean>, keywordFrom: number): Map<number, boolean> {
  const attribute = ranges.filter((range) => range.keywordFrom === keywordFrom)
  const next = new Map(overrides)
  const collapse = !attribute.some((range) => overrides.get(range.from) ?? collapsed)
  for (const range of attribute) next.set(range.from, collapse)
  return next
}

/** Keep original line numbers and colors when the reader replaces class contents with an ellipsis. */
export function classDisplayTokens(tokens: readonly Token[], lineFrom: number, ranges: readonly ClassRange[], attributes: readonly ClassRange[] = ranges): DisplayToken[] {
  const pieces: DisplayToken[] = []
  const spans = tokens.map((token) => { const from = lineFrom; lineFrom += token.value.length; return { token, from, to: lineFrom } })
  const lineStart = spans[0]?.from ?? lineFrom
  const lineEnd = lineFrom
  const append = (from: number, to: number) => {
    for (const span of spans) {
      const start = Math.max(from, span.from), end = Math.min(to, span.to)
      if (start < end) pieces.push({
        type: span.token.type, value: span.token.value.slice(start - span.from, end - span.from),
        classKeyword: attributes.find((range) => range.keywordFrom === start && range.keywordTo === end)?.keywordFrom,
      })
    }
  }
  let position = lineStart
  for (const range of ranges) {
    if (range.to <= lineStart || range.from >= lineEnd) continue
    const start = Math.max(range.from, lineStart), end = Math.min(range.to, lineEnd)
    append(position, start)
    if (range.from >= lineStart) pieces.push({ type: 'string', value: '…', classFold: range })
    position = end
  }
  append(position, lineEnd)
  return pieces
}
