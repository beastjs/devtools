/**
 * Slots are the parts of a BTSX section that can vary between otherwise
 * identical copies: attribute values, element text, and `if`/`switch`
 * conditions. Everything else (tags, selectors, attribute names, keywords,
 * loop headers) forms the skeleton, which must match exactly for copies to be
 * merged into one component or mapped from an array.
 */

export type SlotKind = 'string' | 'expr' | 'text' | 'test'

export interface Slot {
  kind: SlotKind
  /** Range in the section body text, including quotes or braces. */
  start: number
  end: number
  /** Attribute name for `string`/`expr` slots. */
  attr: string | null
  /** Tag of the element the slot belongs to (attributes and inline text). */
  element: string | null
  /** The value as it would be written at a call site, on one line. */
  value: SlotValue
}

export type SlotValue =
  /** A quoted string literal, quotes included. */
  | { type: 'string'; code: string }
  /** A TypeScript expression. */
  | { type: 'expr'; code: string }

export interface ScannedBody {
  slots: Slot[]
  /** The body with every slot replaced by a placeholder. */
  skeleton: string
}

const PLACEHOLDER = '\u0000'
const KEYWORD_TEST = /^(if|elseif|switch|case)\s+/
const KEYWORD_PLAIN = /^(else|default|empty|try|pending|fragment|scope)\s*$/
const KEYWORD_OPAQUE = /^(each|catch|component|props|import|module)\b/
const BLOCK_OPENER = /^(setup|style|module)\s*$/

/**
 * Find the slots of a section body (BTSX rebased to column 0). Returns null
 * for text the scanner does not understand, which callers treat as "cannot
 * be rewritten automatically".
 */
export function scanSlots(body: string): ScannedBody | null {
  const slots: Slot[] = []
  let block: number | null = null // indentation of an open `setup`/`style`/`module` block
  let i = 0

  // Element text runs from `from` to the end of its line.
  const text = (from: number, element: string | null): boolean => {
    const lineEnd = endOfLine(body, from)
    let start = from
    if (body[start] === ' ') start++
    const content = body.slice(start, lineEnd)
    // Beast decodes entities only in text, so such text stays part of the skeleton.
    if (content.trim() === '' || /&[#\w]+;/.test(content)) return true
    const slot = textSlot(start, lineEnd, body.slice(start, lineEnd))
    if (slot === null) return false
    slots.push({ ...slot, element })
    return true
  }

  while (i < body.length) {
    const lineEnd = endOfLine(body, i)
    const indent = /^ */.exec(body.slice(i, lineEnd))![0].length
    const content = body.slice(i + indent, lineEnd)
    const next = lineEnd + 1
    if (content === '') {
      i = next
      continue
    }
    if (block !== null && indent > block) {
      i = next
      continue
    }
    block = null
    if (content.startsWith('//') || content.startsWith('~')) {
      i = next
      continue
    }
    if (content.startsWith('|')) {
      if (!text(i + indent + 1, null)) return null
      i = next
      continue
    }
    const test = KEYWORD_TEST.exec(content)
    if (test !== null) {
      const expression = content.slice(test[0].length).trimEnd()
      const from = i + indent + test[0].length
      slots.push({ kind: 'test', start: from, end: from + expression.length, attr: null, element: null, value: { type: 'expr', code: expression } })
      i = next
      continue
    }
    if (BLOCK_OPENER.test(content)) {
      block = indent
      i = next
      continue
    }
    if (KEYWORD_PLAIN.test(content) || KEYWORD_OPAQUE.test(content) || /^setup\s/.test(content)) {
      i = next
      continue
    }

    const selector = /^[A-Za-z_$.#][\w.#$-]*/.exec(content)
    if (selector === null) return null
    let position = i + indent + selector[0].length
    const element = /^[A-Za-z][\w$-]*/.exec(selector[0])?.[0].split('.')[0] ?? 'div'
    if (body[position] !== '(') {
      if (!text(position, element)) return null
      i = next
      continue
    }

    // Attribute list, which may continue on `~` lines.
    position++
    for (;;) {
      const char = body[position]
      if (char === undefined) return null
      if (char === ' ' || char === ',' || char === '\t') {
        position++
      } else if (char === '\n') {
        position++
        while (body[position] === ' ') position++
        if (body[position] !== '~') return null
        position++
      } else if (char === ')') {
        if (!text(position + 1, element)) return null
        position = endOfLine(body, position) + 1
        break
      } else if (char === '{') {
        const end = closeBrace(body, position)
        if (end === -1) return null
        position = end + 1
      } else {
        const name = /^[A-Za-z_$@:][\w$:.-]*/.exec(body.slice(position, endOfLine(body, position)))
        if (name === null) return null
        position += name[0].length
        if (body[position] !== '=') continue
        position++
        const quote = body[position]
        if (quote === '"' || quote === "'") {
          const end = body.indexOf(quote, position + 1)
          if (end === -1 || end > endOfLine(body, position)) return null
          slots.push({ kind: 'string', start: position, end: end + 1, attr: name[0], element, value: { type: 'string', code: body.slice(position, end + 1) } })
          position = end + 1
        } else if (quote === '{') {
          const end = closeBrace(body, position)
          if (end === -1) return null
          const code = joinContinuations(body.slice(position + 1, end))
          slots.push({ kind: 'expr', start: position, end: end + 1, attr: name[0], element, value: { type: 'expr', code } })
          position = end + 1
        } else {
          return null
        }
      }
    }
    i = position
  }

  let skeleton = ''
  let cursor = 0
  for (const slot of slots) {
    skeleton += body.slice(cursor, slot.start) + PLACEHOLDER
    cursor = slot.end
  }
  skeleton += body.slice(cursor)
  return { slots, skeleton }
}

function endOfLine(text: string, from: number): number {
  const end = text.indexOf('\n', from)
  return end === -1 ? text.length : end
}

/** Rewrite a body, replacing the given slots with references (`{ref}`, `#{ref}`, or a bare condition). */
export function replaceSlots(body: string, slots: readonly Slot[], references: ReadonlyMap<Slot, string>): string {
  let result = ''
  let cursor = 0
  for (const slot of slots) {
    const reference = references.get(slot)
    if (reference === undefined) continue
    result += body.slice(cursor, slot.start)
    result += slot.kind === 'text' ? `#{${reference}}` : slot.kind === 'test' ? reference : `{${reference}}`
    cursor = slot.end
  }
  return result + body.slice(cursor)
}

/** `attr=value` as written at a call site. */
export function attributeValue(value: SlotValue): string {
  return value.type === 'string' ? value.code : `{${value.code}}`
}

/** The value as a TypeScript expression (object properties, type probes). */
export function expressionValue(value: SlotValue): string {
  return value.code
}

/**
 * Element text becomes a string, a single interpolation becomes its
 * expression, and mixed text becomes a template literal.
 */
function textSlot(start: number, end: number, text: string): Slot | null {
  const trimmed = text.trimEnd()
  const finish = start + trimmed.length
  const single = /^#\{([\s\S]*)\}$/.exec(trimmed)
  if (single !== null && closeBrace(trimmed, 1) === trimmed.length - 1) {
    return { kind: 'text', start, end: finish, attr: null, element: null, value: { type: 'expr', code: single[1]!.trim() } }
  }
  if (!trimmed.includes('#{')) {
    return { kind: 'text', start, end: finish, attr: null, element: null, value: { type: 'string', code: quote(trimmed) } }
  }
  let template = ''
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed.startsWith('#{', i)) {
      const close = closeBrace(trimmed, i + 1)
      if (close === -1) return null
      template += '${' + trimmed.slice(i + 2, close) + '}'
      i = close
    } else {
      const char = trimmed[i]!
      template += char === '`' || char === '\\' ? `\\${char}` : char === '$' && trimmed[i + 1] === '{' ? '\\$' : char
    }
  }
  return { kind: 'text', start, end: finish, attr: null, element: null, value: { type: 'expr', code: `\`${template}\`` } }
}

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Index of the brace matching the `{` at `open`, skipping strings and templates. */
function closeBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const char = text[i]!
    if (char === '"' || char === "'" || char === '`') {
      const end = skipString(text, i)
      if (end === -1) return -1
      i = end
    } else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return i
  }
  return -1
}

function skipString(text: string, open: number): number {
  const quoteChar = text[open]
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i]!
    if (char === '\\') i++
    else if (char === quoteChar) return i
    else if (quoteChar === '`' && char === '$' && text[i + 1] === '{') {
      const end = closeBrace(text, i + 1)
      if (end === -1) return -1
      i = end
    }
  }
  return -1
}

/** Join `~` continuation lines inside an expression into one line. */
function joinContinuations(code: string): string {
  return code.replace(/\n[ \t]*~[ \t]?/g, ' ').trim()
}


