import type { FileReport, RefactorSuggestion, SourceBlock } from '../shared/types.ts'

/** Older running dev servers do not yet include templateLine in block metadata. */
export function templateLine(file: FileReport, block: SourceBlock): number | undefined {
  const owner = file.analysis?.components.find((component) => component.name === block.host)
  if (!owner || !file.analysis) return undefined
  const lines = file.source.split('\n')
  for (let index = owner.line - 1; index < block.endLine; index++) {
    if (file.analysis.lineDepths[index] !== 0) continue
    const content = lines[index]?.trim() ?? ''
    if (/^(?:if|each|scope|switch|try|fragment)\b|^[a-z][\w-]*(?=[.#(\s]|$)|^[.#]/.test(content)) return index + 1
  }
  return undefined
}

/** Why a chosen name would be refused, or null when it is usable. */
export function nameIssue(suggestion: RefactorSuggestion, name: string): string | null {
  if (suggestion.kind === 'continuation' || suggestion.kind === 'empty-style') return null
  const component = suggestion.mapping === null
  if (name.trim() === '') return 'Enter a name'
  const pattern = component ? /^[A-Z][A-Za-z0-9_$]*$/ : /^[a-z_$][A-Za-z0-9_$]*$/
  return pattern.test(name.trim()) ? null : component ? 'Use PascalCase, like UserCard' : 'Use a camelCase name, like items'
}

export function miniSuggestions(suggestions: readonly RefactorSuggestion[], line: number) {
  const extract = suggestions.find((item) => item.mapping === null && item.kind === 'extract' && item.startLine === line) ?? null
  const mapping = suggestions.find((item) => item.mapping !== null && item.autoApply.blocked === null) ?? null
  return { extract, mapping }
}

/** The shared title is PascalCase for a component, camelCase for its mapped array/item. */
export function mappingTitle(title: string): string {
  const trimmed = title.trim()
  return trimmed.replace(/^[A-Z]+(?=[A-Z][a-z]|\d|$)|^[A-Z]/, (prefix) => prefix.toLowerCase())
}
