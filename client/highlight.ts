/**
 * A small line-oriented highlighter for BTSX and generated TSRX. It favors
 * cheap, predictable output over precision: every line is tokenized
 * independently, except BTSX `module`/`setup`/`style` blocks, whose indented
 * bodies switch the lexer into TypeScript or CSS mode.
 */

export type TokenType =
  | 'text'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'tag'
  | 'component'
  | 'selector'
  | 'attr'
  | 'directive'
  | 'interp'
  | 'punct'
  | 'type'

export interface Token {
  type: TokenType
  value: string
}

export type Language = 'btsx' | 'tsrx'

const JS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'export',
  'extends', 'false', 'for', 'from', 'function', 'if', 'import', 'in', 'interface', 'let', 'new', 'null', 'of',
  'return', 'switch', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while',
])

const BTSX_KEYWORDS = new Set([
  'case', 'catch', 'component', 'default', 'each', 'else', 'elseif', 'empty', 'fragment', 'if', 'import', 'in',
  'key', 'module', 'pending', 'props', 'scope', 'setup', 'style', 'switch', 'try',
])

/** Header words of `each item, i in items key item.id` and `@for (...; index i; key k)`. */
const EACH_KEYWORDS = new Set(['in', 'key'])
const FOR_KEYWORDS = new Set(['index', 'key'])

/** BTSX keywords whose bare form opens an indented TypeScript or CSS block. */
const BLOCK_OPENERS: Record<string, 'ts' | 'css'> = { module: 'ts', setup: 'ts', style: 'css' }

export function highlight(source: string, language: Language): Token[][] {
  const lines = source.split('\n')
  if (language === 'tsrx') {
    return lines.map((line) => merge(lexCode(line, true, /@for\b/.test(line) ? FOR_KEYWORDS : undefined)))
  }

  let block: { indent: number; mode: 'ts' | 'css' } | null = null
  return lines.map((line) => {
    const indent = /^ */.exec(line)![0].length
    const trimmed = line.trim()
    if (block !== null && (trimmed === '' || indent > block.indent)) {
      return merge(block.mode === 'css' ? lexCss(line) : lexCode(line, false))
    }
    block = null
    const opener = BLOCK_OPENERS[trimmed]
    if (opener !== undefined) block = { indent, mode: opener }
    return merge(lexBtsxLine(line))
  })
}

function lexBtsxLine(line: string): Token[] {
  const lead = /^ */.exec(line)![0]
  const body = line.slice(lead.length)
  const tokens: Token[] = [{ type: 'text', value: lead }]
  if (body.startsWith('//')) return [...tokens, { type: 'comment', value: body }]
  if (body.startsWith('~')) return [...tokens, { type: 'punct', value: '~' }, ...lexCode(body.slice(1), true)]
  if (body.startsWith('|')) return [...tokens, { type: 'punct', value: '|' }, ...lexText(body.slice(1))]

  const word = /^[A-Za-z_$][\w$]*/.exec(body)?.[0]
  if (word !== undefined && BTSX_KEYWORDS.has(word) && !/^[.#(]/.test(body.slice(word.length))) {
    const rest = body.slice(word.length)
    // `component Name` names a component; other keywords are followed by code.
    if (word === 'component') {
      return [...tokens, { type: 'keyword', value: word }, ...lexCode(rest, false).map(asComponentName)]
    }
    return [...tokens, { type: 'keyword', value: word }, ...lexCode(rest, false, word === 'each' ? EACH_KEYWORDS : undefined)]
  }

  const selector = /^([A-Za-z][\w.$-]*)?((?:[#.][\w-]+)*)/.exec(body)
  if (selector === null || selector[0] === '') return [...tokens, ...lexText(body)]
  const [, tag = '', suffix = ''] = selector
  const isComponent = /^[A-Z]/.test(tag)
  if (tag !== '') tokens.push({ type: isComponent ? 'component' : 'tag', value: tag })
  if (suffix !== '') tokens.push({ type: 'selector', value: suffix })

  let rest = body.slice(selector[0].length)
  if (rest.startsWith('(')) {
    const close = matchingParen(rest)
    tokens.push(...lexCode(rest.slice(0, close + 1), true))
    rest = rest.slice(close + 1)
  }
  return [...tokens, ...lexText(rest)]
}

function asComponentName(token: Token): Token {
  return token.type === 'type' ? { type: 'component', value: token.value } : token
}

/** Literal text with `#{...}` interpolations. */
function lexText(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('#{', i)
    if (start === -1) {
      tokens.push({ type: 'text', value: text.slice(i) })
      break
    }
    if (start > i) tokens.push({ type: 'text', value: text.slice(i, start) })
    let depth = 0
    let end = start + 1
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++
      else if (text[end] === '}' && --depth === 0) break
    }
    tokens.push({ type: 'interp', value: '#{' }, ...lexCode(text.slice(start + 2, end), false))
    if (end < text.length) tokens.push({ type: 'interp', value: '}' })
    i = end + 1
  }
  return tokens
}

type Classifier = (match: string, markup: boolean, keywords: ReadonlySet<string> | undefined) => TokenType | null

/** Ordered lexer rules; a classifier returning null lets later rules try. */
const CODE_RULES: Array<[RegExp, TokenType | Classifier]> = [
  [/^\/\/.*/, 'comment'],
  [/^\/\*.*?(\*\/|$)/, 'comment'],
  [/^(['"])(?:\\.|(?!\1).)*\1?/, 'string'],
  [/^`(?:\\.|[^`])*`?/, 'string'],
  [/^\d[\d_]*(?:\.\d+)?/, 'number'],
  [/^@(?:if|else|for|switch|case|default|try|pending|catch|empty)\b/, 'directive'],
  [/^<\/?[A-Za-z][\w.:-]*/, (match, markup) => (!markup ? null : /^<\/?[A-Z]/.test(match) ? 'component' : 'tag')],
  [/^\/?>/, (_match, markup) => (markup ? 'tag' : 'punct')],
  [/^[A-Za-z_$][\w$-]*(?==(?!=))/, (match, markup) => (markup || match.includes('-') ? 'attr' : 'text')],
  [/^[A-Za-z_$][\w$]*/, (match, _markup, keywords) =>
    JS_KEYWORDS.has(match) || keywords?.has(match) === true ? 'keyword' : /^[A-Z]/.test(match) ? 'type' : 'text'],
  [/^\s+/, 'text'],
  [/^[{}()[\];:,.=+\-*/%!?&|<>~^@]/, 'punct'],
]

/** TypeScript-ish code; `markup` enables JSX-style tag and attribute coloring. */
function lexCode(code: string, markup: boolean, keywords?: ReadonlySet<string>): Token[] {
  const tokens: Token[] = []
  let rest = code
  outer: while (rest.length > 0) {
    for (const [pattern, rule] of CODE_RULES) {
      const match = pattern.exec(rest)?.[0]
      if (match === undefined || match === '') continue
      const type = typeof rule === 'function' ? rule(match, markup, keywords) : rule
      if (type === null) continue
      tokens.push({ type, value: match })
      rest = rest.slice(match.length)
      continue outer
    }
    tokens.push({ type: 'text', value: rest[0]! })
    rest = rest.slice(1)
  }
  return tokens
}

function lexCss(line: string): Token[] {
  const comment = line.indexOf('/*')
  if (comment !== -1) return [...lexCss(line.slice(0, comment)), { type: 'comment', value: line.slice(comment) }]
  const declaration = /^(\s*)([\w-]+)(\s*:\s*)(.*?)(;?\s*)$/.exec(line)
  if (declaration !== null && !line.trimEnd().endsWith('{')) {
    const [, lead = '', property = '', colon = '', value = '', end = ''] = declaration
    return [
      { type: 'text', value: lead },
      { type: 'attr', value: property },
      { type: 'punct', value: colon },
      { type: 'string', value },
      { type: 'punct', value: end },
    ]
  }
  return [{ type: 'selector', value: line }]
}

function matchingParen(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quote !== null) {
      if (char === '\\') i++
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '(' || char === '{' || char === '[') depth++
    else if ((char === ')' || char === '}' || char === ']') && --depth === 0) return i
  }
  return text.length - 1
}

function merge(tokens: Token[]): Token[] {
  const merged: Token[] = []
  for (const token of tokens) {
    if (token.value === '') continue
    const last = merged.at(-1)
    if (last !== undefined && last.type === token.type) last.value += token.value
    else merged.push({ ...token })
  }
  return merged
}
