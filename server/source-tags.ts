import { sep } from 'node:path'
import { componentNameFromPath, parse, type BeastDocument, type BeastNode } from 'beast-tsrx'
import { COMPONENT_ATTRIBUTE, SOURCE_ATTRIBUTE } from '../shared/types.js'

/**
 * Tag every DOM element of a `.btsx` source with the component that renders it
 * and its `path:line:column`, for the overlay's element picker:
 *
 *   li.item(key={id}) #{label}
 *   li.item(data-beast-src="src/List.btsx:4:5" data-beast-component="List" key={id}) #{label}
 *
 * The attributes are static, so Octane bakes them into its templates at no
 * runtime cost. Component calls are left alone (the attributes would become
 * props), and so is any source that does not parse; Beast reports that error.
 * Only lines holding a tagged element change, so line numbers stay exact.
 */
export function tagSource(source: string, filename: string, path: string): string {
  let document: BeastDocument
  try {
    document = parse(source, filename)
  } catch {
    return source
  }

  const inserts: Array<{ offset: number; text: string }> = []
  const visit = (nodes: readonly BeastNode[], component: string) => {
    for (const node of nodes) {
      switch (node.kind) {
        case 'element': {
          if (!node.isComponent) inserts.push(insertion(source, node.span.start, component, path))
          visit(node.children, component)
          break
        }
        case 'fragment':
        case 'scope':
          visit(node.children, component)
          break
        case 'if':
        case 'switch':
          for (const branch of node.branches) visit(branch.children, component)
          break
        case 'each':
          visit(node.children, component)
          visit(node.emptyChildren ?? [], component)
          break
        case 'try':
          visit(node.children, component)
          visit(node.pendingBranch?.children ?? [], component)
          visit(node.catchBranch?.children ?? [], component)
          break
        case 'text':
        case 'style':
          break
      }
    }
  }

  visit(document.children, componentNameFromPath(filename))
  for (const declaration of document.declarations) {
    if (declaration.kind === 'component') visit(declaration.children, declaration.name)
  }

  let result = source
  for (const { offset, text } of inserts.sort((a, b) => b.offset - a.offset)) {
    result = result.slice(0, offset) + text + result.slice(offset)
  }
  return result
}

/** Attributes go first in the element's list, or in a new list right after its selector. */
function insertion(
  source: string,
  start: { offset: number; line: number; column: number },
  component: string,
  path: string,
): { offset: number; text: string } {
  let end = start.offset
  while (end < source.length && !/[\s(]/u.test(source[end]!)) end++
  const attributes = `${SOURCE_ATTRIBUTE}="${attributeText(`${path}:${start.line}:${start.column}`)}" ${COMPONENT_ATTRIBUTE}="${attributeText(component)}"`
  return source[end] === '(' ? { offset: end + 1, text: `${attributes} ` } : { offset: end, text: `(${attributes})` }
}

/** Keep the value a plain string literal: no quotes, escapes or `#{}` interpolation. */
function attributeText(value: string): string {
  return value.replace(/["'\\#{}\r\n]/gu, '_')
}

/** Project `.btsx` modules get tagged; the overlay's own sources and installed packages do not. */
export function isTaggable(file: string, packageRoot: string): boolean {
  return file.endsWith('.btsx') && !file.startsWith(packageRoot + sep) && !file.split(sep).includes('node_modules')
}
