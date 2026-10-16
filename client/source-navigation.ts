import type { ComponentLocation, SourceBlockSelection } from '../shared/types.ts'
import type { ScrollTarget } from './util.ts'

export interface SourceFocus extends ScrollTarget {
  path: string
  host?: string
}

/** Resolve a file position to the complete component that can edit it. */
export function componentSourceSelection(components: readonly ComponentLocation[], focus: SourceFocus): SourceBlockSelection | null {
  const candidates = components.filter((component) => component.path === focus.path && (focus.host === undefined || component.name === focus.host))
  const containing = candidates.flatMap((component) => {
    const block = component.blocks?.find((block) => block.kind === 'component' && block.scope === component.name)
    return block && block.startLine <= focus.line && focus.line <= block.endLine ? [{ component, block }] : []
  }).sort((a, b) => (a.block.endLine - a.block.startLine) - (b.block.endLine - b.block.startLine))[0]
  const component = containing?.component ?? candidates.find((component) => !component.local) ?? candidates[0]
  if (!component) return null
  const line = containing?.block.startLine ?? component.blocks?.find((block) => block.kind === 'component' && block.scope === component.name)?.startLine ?? (component.local ? component.line : 1)
  return { path: component.path, host: component.name, line, kind: 'component' }
}
