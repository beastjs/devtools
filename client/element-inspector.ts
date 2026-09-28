import { COMPONENT_ATTRIBUTE, SOURCE_ATTRIBUTE } from '../shared/types.ts'

export type ElementPropertyGroup = 'styles' | 'attributes' | 'properties'
export interface ElementProperty {
  name: string
  value: string
  editable: boolean
  type?: 'boolean' | 'number' | 'string'
  inline?: boolean
}
export interface StyleEdit {
  /** Applies CSS declarations to the element right away. */
  set(declarations: Readonly<Record<string, string>>): void
  /** Keeps the changes as one undo step. */
  commit(): void
  /** Restores the inline style from before the edit. */
  cancel(): void
}
export interface ElementSnapshot {
  label: string
  component: string | null
  source: string | null
  connected: boolean
  width: number
  height: number
  attributes: ElementProperty[]
  styles: ElementProperty[]
  properties: ElementProperty[]
}

const EDITABLE_PROPERTIES = new Set([
  'value', 'checked', 'selected', 'disabled', 'hidden', 'readOnly', 'required', 'multiple', 'tabIndex', 'title', 'id', 'className', 'placeholder', 'textContent',
  'innerText', 'lang', 'dir', 'draggable', 'spellcheck', 'contentEditable', 'inert', 'autofocus', 'translate', 'accessKey', 'open', 'indeterminate',
  'name', 'type', 'href', 'src', 'alt', 'min', 'max', 'step', 'pattern', 'maxLength', 'minLength',
])
// Replacing these drops element children, so only offer them on text-only elements.
const TEXT_PROPERTIES = new Set(['textContent', 'innerText'])
const PROTECTED_ATTRIBUTES = new Set([SOURCE_ATTRIBUTE, COMPONENT_ATTRIBUTE])
export const COMMON_STYLES = new Set(['display', 'position', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'align-items', 'justify-content', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'border-radius', 'border-width', 'border-color', 'opacity', 'overflow', 'box-shadow'])

export function elementLabel(element: Element): string {
  return `${element.localName}${element.id ? `#${element.id}` : ''}`
}

function inlineStyle(element: Element): CSSStyleDeclaration {
  if (!('style' in element)) throw new Error('This element does not support inline styles.')
  return (element as HTMLElement | SVGElement).style
}

function displayValue(value: unknown): string {
  if (typeof value === 'function') return '[Function]'
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'object') return Object.prototype.toString.call(value)
  return String(value)
}

export function captureElement(element: Element): ElementSnapshot {
  const rect = element.getBoundingClientRect()
  const computed = element.ownerDocument.defaultView!.getComputedStyle(element)
  const style = 'style' in element ? inlineStyle(element) : null
  const attributes = Array.from(element.attributes, (attribute) => ({
    name: attribute.name, value: attribute.value,
    editable: !PROTECTED_ATTRIBUTES.has(attribute.name) && !/^on/i.test(attribute.name),
  }))
  const styles = Array.from(computed, (name) => ({
    name, value: style?.getPropertyValue(name) ? `${style.getPropertyValue(name)}${style.getPropertyPriority(name) ? ' !important' : ''}` : computed.getPropertyValue(name),
    editable: style !== null, inline: !!style?.getPropertyValue(name),
  }))
  // Include custom properties and inline declarations omitted from computed enumeration.
  if (style) for (const name of Array.from(style)) {
    if (!styles.some((entry) => entry.name === name)) styles.push({ name, value: `${style.getPropertyValue(name)}${style.getPropertyPriority(name) ? ' !important' : ''}`, editable: true, inline: true })
  }
  // The nearest descriptor wins, so a read-only getter (e.g. `select.type`) is not offered.
  const descriptors = new Map<string, PropertyDescriptor>()
  for (let object: object | null = element; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) {
      const descriptor = descriptors.has(name) ? undefined : Object.getOwnPropertyDescriptor(object, name)
      if (descriptor) descriptors.set(name, descriptor)
    }
  }
  const textOnly = Array.from(element.childNodes).every((node) => node.nodeType === 3)
  const properties: ElementProperty[] = [...descriptors.keys()].sort().map((name) => {
    try {
      const value = Reflect.get(element, name)
      const type = typeof value
      const primitive = type === 'string' || type === 'number' || type === 'boolean'
      const descriptor = descriptors.get(name)!
      const writable = descriptor.set !== undefined || descriptor.writable === true
      return {
        name, value: displayValue(value),
        editable: primitive && writable && EDITABLE_PROPERTIES.has(name) && (!TEXT_PROPERTIES.has(name) || textOnly),
        ...(primitive ? { type: type as 'string' | 'number' | 'boolean' } : {}),
      }
    } catch { return { name, value: '[Unavailable]', editable: false } }
  })
  return {
    label: elementLabel(element), component: element.getAttribute(COMPONENT_ATTRIBUTE), source: element.getAttribute(SOURCE_ATTRIBUTE),
    connected: element.isConnected, width: rect.width, height: rect.height,
    attributes: attributes.sort((a, b) => a.name.localeCompare(b.name)), styles: styles.sort((a, b) => a.name.localeCompare(b.name)), properties,
  }
}

/** Live edits belong to the selected DOM node, and survive panel/tab changes. */
export class ElementInspection {
  readonly element: Element
  readonly #undo: Array<() => void> = []
  constructor(element: Element) { this.element = element }
  get undoCount(): number { return this.#undo.length }
  capture(): ElementSnapshot { return captureElement(this.element) }

  edit(group: ElementPropertyGroup, name: string, value: string | null): void {
    const element = this.element
    if (!element.isConnected) throw new Error('This element is no longer on the page. Pick it again.')
    if (group === 'styles') {
      const style = inlineStyle(element)
      const oldStyle = element.getAttribute('style')
      if (value === null || value.trim() === '') style.removeProperty(name)
      else {
        const important = /\s*!important\s*$/i.test(value)
        const next = value.replace(/\s*!important\s*$/i, '').trim()
        if (!name.startsWith('--') && !CSS.supports(name, next)) throw new Error(`Invalid CSS value for ${name}.`)
        style.setProperty(name, next, important ? 'important' : '')
      }
      if (element.getAttribute('style') === oldStyle) return
      this.#undo.push(() => {
        // Restore the complete declaration, including longhands affected by a shorthand.
        if (oldStyle === null) element.removeAttribute('style')
        else element.setAttribute('style', oldStyle)
      })
    } else if (group === 'attributes') {
      if (PROTECTED_ATTRIBUTES.has(name) || /^on/i.test(name)) throw new Error('This attribute is read-only.')
      const before = element.getAttribute(name)
      if (before === value) return
      if (value === null) element.removeAttribute(name)
      else element.setAttribute(name, value)
      this.#undo.push(() => { if (before === null) element.removeAttribute(name); else element.setAttribute(name, before) })
    } else {
      const property = this.capture().properties.find((entry) => entry.name === name)
      if (!property?.editable || value === null) throw new Error('This DOM property is read-only.')
      const next = property.type === 'boolean' ? value === 'true' : property.type === 'number' ? Number(value) : value
      if (property.type === 'number' && !Number.isFinite(next)) throw new Error('Enter a finite number.')
      if (property.type === 'boolean' && value !== 'true' && value !== 'false') throw new Error('Use true or false.')
      const before = Reflect.get(element, name)
      if (Object.is(before, next)) return
      if (!Reflect.set(element, name, next)) throw new Error('This DOM property could not be changed.')
      this.#undo.push(() => { Reflect.set(element, name, before) })
    }
  }

  /** Live inline-style changes, such as a drag, that land as one undo step. */
  beginStyleEdit(): StyleEdit {
    const element = this.element
    if (!element.isConnected) throw new Error('This element is no longer on the page. Pick it again.')
    const style = inlineStyle(element)
    const before = element.getAttribute('style')
    const restore = () => {
      if (before === null) element.removeAttribute('style')
      else element.setAttribute('style', before)
    }
    let done = false
    return {
      set: (declarations) => {
        if (!done) for (const [name, value] of Object.entries(declarations)) style.setProperty(name, value)
      },
      commit: () => {
        if (done) return
        done = true
        if (element.getAttribute('style') !== before) this.#undo.push(restore)
      },
      cancel: () => {
        if (done) return
        done = true
        restore()
      },
    }
  }

  undo(): void {
    if (!this.element.isConnected) throw new Error('This element is no longer on the page. Pick it again.')
    const undo = this.#undo.at(-1)
    if (undo) { undo(); this.#undo.pop() }
  }
}
