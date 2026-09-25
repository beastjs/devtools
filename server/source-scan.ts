/**
 * Lightweight lexical helpers for the TypeScript slices Beast keeps verbatim
 * (setup code, props parameters, attribute expressions). They deliberately
 * avoid a full parser: devtools only needs identifier names, top-level
 * declarations, and a few hook shapes.
 */

const RESERVED = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'null', 'of', 'return', 'satisfies', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
])

/**
 * Replace string, template, and comment contents with spaces so structural
 * scanning cannot be confused by quoted brackets. Offsets are preserved.
 * With `keepTemplateExpressions`, `${...}` bodies inside template literals are
 * kept because they reference identifiers.
 */
export function maskLiterals(code: string, keepTemplateExpressions = false): string {
  const out = [...code]
  let i = 0
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }

  const skipTemplate = (start: number): number => {
    let j = start + 1
    let literalStart = j
    while (j < code.length) {
      const char = code[j]
      if (char === '\\') {
        j += 2
        continue
      }
      if (char === '`') {
        blank(literalStart, j)
        return j + 1
      }
      if (char === '$' && code[j + 1] === '{') {
        blank(literalStart, j)
        const end = skipBalanced(j + 1)
        // `$` is an identifier character, so it is always masked.
        blank(j, keepTemplateExpressions ? j + 1 : end)
        j = end
        literalStart = j
        continue
      }
      j++
    }
    blank(literalStart, j)
    return j
  }

  // Scan from an opening `{` to just past its matching `}`, honoring nested literals.
  const skipBalanced = (open: number): number => {
    let depth = 0
    let j = open
    while (j < code.length) {
      const char = code[j]
      if (char === '"' || char === "'") {
        j = skipQuoted(j)
        continue
      }
      if (char === '`') {
        j = skipTemplate(j)
        continue
      }
      if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) return j + 1
      }
      j++
    }
    return j
  }

  const skipQuoted = (start: number): number => {
    const quote = code[start]
    let j = start + 1
    while (j < code.length && code[j] !== quote && code[j] !== '\n') {
      j += code[j] === '\\' ? 2 : 1
    }
    blank(start + 1, j)
    return j + 1
  }

  while (i < code.length) {
    const char = code[i]
    const next = code[i + 1]
    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      blank(i, stop)
      i = stop
    } else if (char === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? code.length : end + 2
      blank(i, stop)
      i = stop
    } else if (char === '"' || char === "'") {
      i = skipQuoted(i)
    } else if (char === '`') {
      i = skipTemplate(i)
    } else {
      i++
    }
  }
  return out.join('')
}

/** Every identifier referenced by an expression, excluding property names and keywords. */
export function identifiersIn(code: string): Set<string> {
  const masked = maskLiterals(code, true)
  const names = new Set<string>()
  const pattern = /[A-Za-z_$][\w$]*/g
  for (const match of masked.matchAll(pattern)) {
    const name = match[0]
    if (RESERVED.has(name)) continue
    const before = masked.slice(0, match.index).trimEnd()
    // `a.b` and `a?.b` are property reads of `b`; `...b` is a spread of `b`.
    if (before.endsWith('.') && !before.endsWith('...')) continue
    names.add(name)
  }
  return names
}

/** Names bound by a destructuring pattern or a plain identifier. */
export function patternNames(pattern: string): string[] {
  const text = pattern.trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    const inner = text.slice(1, matchingClose(text, 0))
    return splitTopLevel(inner, ',').flatMap((part) => {
      let entry = part.trim()
      if (entry === '') return []
      if (entry.startsWith('...')) entry = entry.slice(3)
      const eq = indexOfTopLevel(entry, '=')
      if (eq !== -1) entry = entry.slice(0, eq)
      if (text.startsWith('{')) {
        const colon = indexOfTopLevel(entry, ':')
        if (colon !== -1) return patternNames(entry.slice(colon + 1))
      }
      return patternNames(entry)
    })
  }
  const identifier = /^[A-Za-z_$][\w$]*/.exec(text)
  return identifier ? [identifier[0]] : []
}

export interface Declaration {
  names: string[]
  /** Source text of the initializer (up to the end of the statement). */
  init: string
  /** Offset of the declaration keyword inside the scanned code. */
  offset: number
}

/** Top-level `const`/`let`/`var`/`function`/`class` declarations of a code block. */
export function topLevelDeclarations(code: string): Declaration[] {
  const masked = maskLiterals(code)
  const declarations: Declaration[] = []
  let depth = 0
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i]!
    if (char === '{' || char === '(' || char === '[') depth++
    else if (char === '}' || char === ')' || char === ']') depth--
    if (depth !== 0 || !/[a-z]/.test(char) || /[\w$]/.test(masked[i - 1] ?? '')) continue

    const keyword = /^(const|let|var|function|class|async\s+function)\s+/.exec(masked.slice(i))
    if (keyword === null) continue
    const rest = i + keyword[0].length
    if (keyword[1] === 'const' || keyword[1] === 'let' || keyword[1] === 'var') {
      const opener = masked[rest]
      const patternEnd = opener === '{' || opener === '['
        ? matchingClose(masked, rest) + 1
        : rest + (/^[A-Za-z_$][\w$]*/.exec(masked.slice(rest))?.[0].length ?? 0)
      const eq = masked.indexOf('=', patternEnd)
      const end = statementEnd(masked, eq === -1 ? patternEnd : eq + 1)
      declarations.push({
        names: patternNames(code.slice(rest, patternEnd)),
        init: eq === -1 ? '' : code.slice(eq + 1, end).trim(),
        offset: i,
      })
      i = end - 1
    } else {
      const name = /^\*?\s*([A-Za-z_$][\w$]*)/.exec(masked.slice(rest))?.[1]
      if (name !== undefined) declarations.push({ names: [name], init: '', offset: i })
      i = rest
    }
  }
  return declarations
}

/** Split a `props` parameter such as `{ a, b = 1 }: Props` into names and type text. */
export function parsePropsParameter(parameter: string): { names: string[]; type: string | null } {
  const text = parameter.trim().replace(/;$/, '')
  const masked = maskLiterals(text)
  const patternEnd = text.startsWith('{') || text.startsWith('[')
    ? matchingClose(masked, 0) + 1
    : (/^[A-Za-z_$][\w$]*/.exec(text)?.[0].length ?? 0)
  const names = patternNames(text.slice(0, patternEnd))
  const rest = text.slice(patternEnd).trim()
  return { names, type: rest.startsWith(':') ? rest.slice(1).trim() || null : null }
}

/** Return the balanced type-argument text after `callee<`, if the initializer starts with it. */
export function hookCall(init: string): { hook: string; typeArgument: string | null; argument: string } | null {
  const match = /^(?:await\s+)?(use[A-Z]\w*)\s*/.exec(init)
  if (match === null) return null
  let i = match[0].length
  let typeArgument: string | null = null
  if (init[i] === '<') {
    let depth = 0
    const start = i
    for (; i < init.length; i++) {
      if (init[i] === '<') depth++
      else if (init[i] === '>' && init[i - 1] !== '=') {
        depth--
        if (depth === 0) break
      }
    }
    typeArgument = init.slice(start + 1, i).trim()
    i++
  }
  if (init[i] !== '(') return null
  const close = matchingClose(maskLiterals(init), i)
  const args = splitTopLevel(init.slice(i + 1, close), ',')
  return { hook: match[1]!, typeArgument, argument: (args[0] ?? '').trim() }
}

function matchingClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
  const stack: string[] = []
  for (let i = open; i < text.length; i++) {
    const char = text[i]!
    if (char in pairs) stack.push(pairs[char]!)
    else if (char === stack.at(-1)) {
      stack.pop()
      if (stack.length === 0) return i
    }
  }
  return text.length
}

function splitTopLevel(text: string, separator: string): string[] {
  const masked = maskLiterals(text)
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i]!
    if ('{[(<'.includes(char)) depth++
    else if ('}])>'.includes(char) && !(char === '>' && masked[i - 1] === '=')) depth--
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function indexOfTopLevel(text: string, char: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const current = text[i]!
    if ('{[(<'.includes(current)) depth++
    else if ('}])>'.includes(current) && !(current === '>' && text[i - 1] === '=')) depth--
    else if (current === char && depth === 0) return i
  }
  return -1
}

function statementEnd(masked: string, from: number): number {
  let depth = 0
  for (let i = from; i < masked.length; i++) {
    const char = masked[i]!
    if (char === '{' || char === '(' || char === '[') depth++
    else if (char === '}' || char === ')' || char === ']') {
      if (depth === 0) return i
      depth--
    } else if (depth === 0 && (char === ';' || char === '\n')) {
      // A newline only ends the statement when the next line does not continue it.
      if (char === ';') return i
      const rest = masked.slice(i + 1).trimStart()
      if (!/^[.?:+\-*/%&|=,)]/.test(rest) && !/[=,(+\-*/%&|?:]\s*$/.test(masked.slice(from, i))) return i
    }
  }
  return masked.length
}
