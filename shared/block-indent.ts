/** Rebase a pasted/edited block to its fixed outer margin, retaining relative nesting. */
export function pinBlockIndent(code: string, indent: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[0]!.trim()) lines.shift()
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  const margin = /^[ \t]*/.exec(lines[0] ?? '')![0].replace(/\t/g, '  ').length
  return lines.map((line) => {
    if (!line.trim()) return ''
    const leading = /^[ \t]*/.exec(line)![0]
    return indent + ' '.repeat(Math.max(0, leading.replace(/\t/g, '  ').length - margin)) + line.slice(leading.length)
  }).join('\n')
}
