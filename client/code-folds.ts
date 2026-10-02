/** Block headers mapped to their last line (1-based), including TSRX closing delimiters. */
export function codeFolds(source: string, language: 'btsx' | 'tsrx' = 'btsx'): Map<number, number> {
  const folds = new Map<number, number>()
  const stack: { line: number; indent: number }[] = []
  let last = 0
  for (const [index, text] of source.split('\n').entries()) {
    if (text.trim() === '') continue
    const line = index + 1
    const content = text.trim()
    const indent = /^\s*/.exec(text)![0].replace(/\t/g, '  ').length
    const closing = language === 'tsrx' && /^(?:<\/[^>]+>|[}\])]+[;,]?)$/.test(content)
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) {
      const header = stack.pop()!
      const end = closing && header.indent === indent ? line : last
      if (end > header.line) folds.set(header.line, end)
    }
    // Continuation lines are part of the header, never block openers.
    if (!closing && !content.startsWith('~') && !content.startsWith('//')) stack.push({ line, indent })
    last = line
  }
  for (const header of stack) if (last > header.line) folds.set(header.line, last)
  return folds
}

export function hiddenCodeLines(folds: ReadonlyMap<number, number>, collapsed: ReadonlySet<number>): Set<number> {
  const hidden = new Set<number>()
  for (const start of collapsed) {
    const end = folds.get(start)
    if (end === undefined) continue
    for (let line = start + 1; line <= end; line++) hidden.add(line)
  }
  return hidden
}
