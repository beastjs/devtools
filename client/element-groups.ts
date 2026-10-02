import type { ElementProperty } from './element-inspector.ts'

export interface ElementSection {
  id: string
  /** `null` renders the rows without a section header. */
  label: string | null
  properties: ElementProperty[]
  /** Noisy sections (methods, handlers, constants) start folded. */
  collapsed: boolean
  columns: 1 | 2
}

interface Category {
  id: string
  label: string
  names?: readonly string[]
  prefixes?: readonly string[]
  test?: (property: ElementProperty) => boolean
  collapsed?: boolean
}

function inCategory(category: Category, property: ElementProperty): boolean {
  return (category.test?.(property) ?? false)
    || (category.names?.includes(property.name) ?? false)
    || (category.prefixes?.some((prefix) => property.name.startsWith(prefix)) ?? false)
}

/**
 * Buckets properties by the first matching category (in `match` order), then
 * returns the non-empty buckets in `display` order.
 */
function bucket(properties: readonly ElementProperty[], match: readonly Category[], display: readonly string[], columns: 1 | 2): ElementSection[] {
  const other: Category = { id: 'other', label: 'Other' }
  const buckets = new Map<string, ElementProperty[]>()
  for (const property of properties) {
    const category = match.find((entry) => inCategory(entry, property)) ?? other
    const list = buckets.get(category.id)
    if (list) list.push(property)
    else buckets.set(category.id, [property])
  }
  return display.flatMap((id) => {
    const category = match.find((entry) => entry.id === id) ?? other
    const list = buckets.get(id)
    return list ? [{ id, label: category.label, properties: list, collapsed: category.collapsed ?? false, columns }] : []
  })
}

// Most useful edits first; booleans follow the text and number fields.
const EDITABLE_ORDER = ['textContent', 'innerText', 'value', 'id', 'className', 'title', 'placeholder', 'href', 'src', 'alt', 'name', 'type', 'lang', 'dir', 'contentEditable', 'tabIndex']

function editableRank(property: ElementProperty): number {
  const index = EDITABLE_ORDER.indexOf(property.name)
  return (property.type === 'boolean' ? 1000 : 0) + (index === -1 ? EDITABLE_ORDER.length : index)
}

const PROPERTY_CATEGORIES: readonly Category[] = [
  { id: 'constants', label: 'Constants', collapsed: true, test: ({ name }) => /^[A-Z][A-Z0-9_]*$/.test(name) },
  { id: 'events', label: 'Event handlers', collapsed: true, test: ({ name }) => /^on[a-z]/.test(name) },
  { id: 'methods', label: 'Methods', collapsed: true, test: ({ value }) => value === '[Function]' },
  { id: 'accessibility', label: 'Accessibility', names: ['role'], test: ({ name }) => /^aria[A-Z]/.test(name) },
  { id: 'content', label: 'Content', names: ['textContent', 'innerText', 'outerText', 'innerHTML', 'outerHTML', 'nodeValue', 'data'] },
  {
    id: 'identity', label: 'Identity',
    names: ['id', 'className', 'classList', 'tagName', 'localName', 'nodeName', 'nodeType', 'namespaceURI', 'prefix', 'baseURI', 'dataset', 'attributes', 'part', 'slot', 'lang', 'dir', 'title', 'nonce', 'style', 'attributeStyleMap'],
  },
  {
    id: 'form', label: 'Form',
    names: ['value', 'checked', 'indeterminate', 'selected', 'form', 'name', 'type', 'validity', 'validationMessage', 'willValidate', 'labels', 'required', 'readOnly', 'multiple', 'min', 'max', 'step', 'pattern', 'placeholder', 'maxLength', 'minLength', 'size', 'autocomplete', 'disabled', 'files', 'list', 'accept', 'options', 'selectedIndex', 'selectedOptions', 'length', 'htmlFor', 'control', 'label', 'dirName', 'wrap', 'rows', 'cols', 'textLength'],
    prefixes: ['form', 'selection', 'valueAs', 'default'],
  },
  {
    id: 'interaction', label: 'Interaction & focus',
    names: ['tabIndex', 'hidden', 'inert', 'draggable', 'contentEditable', 'isContentEditable', 'autofocus', 'spellcheck', 'translate', 'autocapitalize', 'autocorrect', 'writingSuggestions', 'enterKeyHint', 'inputMode', 'popover', 'accessKey', 'accessKeyLabel', 'editContext', 'open'],
  },
  {
    id: 'layout', label: 'Layout & scroll', names: ['currentCSSZoom'],
    test: ({ name }) => /^(offset|client|scroll)[A-Z]/.test(name),
  },
  {
    id: 'tree', label: 'Tree',
    names: ['parentNode', 'parentElement', 'childNodes', 'children', 'firstChild', 'lastChild', 'firstElementChild', 'lastElementChild', 'previousSibling', 'nextSibling', 'previousElementSibling', 'nextElementSibling', 'childElementCount', 'ownerDocument', 'isConnected', 'shadowRoot', 'assignedSlot'],
  },
  {
    id: 'media', label: 'Links & media',
    names: ['href', 'src', 'srcset', 'sizes', 'alt', 'currentSrc', 'naturalWidth', 'naturalHeight', 'complete', 'loading', 'decoding', 'crossOrigin', 'referrerPolicy', 'fetchPriority', 'target', 'rel', 'relList', 'download', 'hreflang', 'ping', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'username', 'password', 'width', 'height', 'useMap', 'isMap', 'x', 'y'],
  },
]
const PROPERTY_DISPLAY = ['content', 'identity', 'form', 'interaction', 'accessibility', 'layout', 'tree', 'media', 'other', 'events', 'methods', 'constants']

/** Editable DOM properties first, then read-only ones grouped by category. */
export function groupProperties(properties: readonly ElementProperty[]): ElementSection[] {
  const editable = properties.filter((property) => property.editable).sort((a, b) => editableRank(a) - editableRank(b))
  const readonly = properties.filter((property) => !property.editable)
  return [
    ...(editable.length ? [{ id: 'editable', label: 'Editable', properties: editable, collapsed: false, columns: 2 as const }] : []),
    ...bucket(readonly, PROPERTY_CATEGORIES, PROPERTY_DISPLAY, 2),
  ]
}

// Matched in this order, so e.g. `column-gap` lands in Flex & grid before
// `column-` reaches Layout, and `border-radius` in Border before anything else.
const STYLE_CATEGORIES: readonly Category[] = [
  { id: 'custom', label: 'Custom properties', prefixes: ['--'] },
  { id: 'layout', label: 'Layout · Flex & grid', names: ['gap', 'row-gap', 'column-gap', 'order'], prefixes: ['flex', 'grid', 'align-', 'justify-', 'place-'] },
  {
    id: 'size', label: 'Size',
    names: ['width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'min-inline-size', 'max-inline-size', 'min-block-size', 'max-block-size', 'aspect-ratio'],
  },
  { id: 'spacing', label: 'Spacing', prefixes: ['margin', 'padding'] },
  { id: 'border', label: 'Border & outline', prefixes: ['border', 'outline'] },
  { id: 'motion', label: 'Animation & transition', prefixes: ['animation', 'transition', 'offset-'] },
  {
    id: 'typography', label: 'Typography',
    names: ['white-space', 'white-space-collapse', 'tab-size', 'writing-mode', 'direction', 'unicode-bidi', 'vertical-align', 'quotes', 'overflow-wrap'],
    prefixes: ['font', 'text-', 'letter-', 'word-', 'line-', 'hyphen', 'list-style', 'counter-'],
  },
  {
    id: 'color', label: 'Color & background',
    names: ['color', 'opacity', 'accent-color', 'caret-color', 'color-scheme', 'mix-blend-mode', 'fill', 'fill-opacity', 'fill-rule', 'color-interpolation', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'lighting-color'],
    prefixes: ['background', 'stroke'],
  },
  {
    id: 'effects', label: 'Effects & transforms',
    names: ['box-shadow', 'filter', 'backdrop-filter', 'translate', 'rotate', 'scale', 'backface-visibility', 'will-change'],
    prefixes: ['transform', 'perspective', 'clip', 'mask'],
  },
  {
    id: 'interaction', label: 'Interaction',
    names: ['cursor', 'pointer-events', 'user-select', 'touch-action', 'resize', 'appearance', 'caret', 'interpolate-size'],
    prefixes: ['scroll-', 'overscroll-', 'scrollbar-'],
  },
  {
    id: 'layout', label: 'Layout · Flex & grid',
    names: ['display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear', 'box-sizing', 'visibility', 'isolation', 'content-visibility', 'object-fit', 'object-position', 'columns', 'zoom'],
    prefixes: ['inset', 'overflow', 'contain', 'column-', 'anchor-', 'position-'],
  },
]
const STYLE_DISPLAY = ['layout', 'size', 'spacing', 'typography', 'color', 'border', 'effects', 'motion', 'interaction', 'custom', 'other']

export function groupStyles(styles: readonly ElementProperty[]): ElementSection[] {
  const primary = new Set(['layout', 'size', 'spacing', 'typography'])
  return bucket(styles, STYLE_CATEGORIES, STYLE_DISPLAY, 1).map((section) => ({
    ...section, collapsed: !primary.has(section.id),
  }))
}

export function groupAttributes(attributes: readonly ElementProperty[]): ElementSection[] {
  return attributes.length ? [{ id: 'all', label: null, properties: [...attributes], collapsed: false, columns: 1 }] : []
}
