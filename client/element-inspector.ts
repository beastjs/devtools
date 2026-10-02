import { fetchFile, saveElementEdit, undoRefactor } from './api.ts'
import { DEFAULT_SETTINGS, type ElementEditRequest, COMPONENT_ATTRIBUTE, SOURCE_ATTRIBUTE } from '../shared/types.ts'

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
  /** Saves the changes to source as one undo step. */
  commit(): Promise<void>
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
  'innerText', 'lang', 'dir', 'draggable', 'spellcheck', 'contentEditable', 'inert', 'autofocus', 'translate', 'accessKey', 'open',
  'name', 'type', 'href', 'src', 'alt', 'min', 'max', 'step', 'pattern', 'maxLength', 'minLength',
])
// Replacing these drops element children, so only offer them on text-only elements.
const TEXT_PROPERTIES = new Set(['textContent', 'innerText'])
const PROTECTED_ATTRIBUTES = new Set([SOURCE_ATTRIBUTE, COMPONENT_ATTRIBUTE])
export const COMMON_STYLES = new Set(['flex-direction', 'flex-wrap', 'align-items', 'align-content', 'justify-content', 'grid-template-columns', 'grid-template-rows', 'flex-grow', 'flex-shrink', 'display', 'position', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'align-items', 'justify-content', 'color', 'background-color', 'font-size', 'font-weight', 'line-height', 'border-radius', 'border-width', 'border-color', 'opacity', 'overflow', 'box-shadow'])

export function elementLabel(element: Element): string {
  return `${element.localName}${element.id ? `#${element.id}` : ''}`
}

/**
 * Stable identity for a capture: captures hold only plain data in a fixed
 * shape, so identical elements stringify identically. The Elements panel
 * compares this key to skip re-rendering on idle refresh ticks.
 */
export function snapshotKey(snapshot: ElementSnapshot | null): string {
  return snapshot === null ? 'null' : JSON.stringify(snapshot)
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

/** Source-backed edits survive reloads; the selected node is rebound after HMR. */
const MAX_UNDO_STEPS = 50

export class ElementInspection {
  #element: Element
  readonly #source: string | null
  readonly #index: number
  readonly #ready: Promise<void>
  #hash = ''
  #version = 0
  #saved: Array<{ id: string; hash: string }> = []
  #listeners = new Set<() => void>()
  saving = false
  error: string | null = null
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  #notify(): void { for (const listener of this.#listeners) listener() }
  get element(): Element {
    if (!this.#element.isConnected && this.#source) {
      const matches = [...document.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)].filter((el) => el.getAttribute(SOURCE_ATTRIBUTE) === this.#source)
      this.#element = matches[this.#index] ?? this.#element
    }
    return this.#element
  }
  readonly #undo: Array<() => void> = []
  constructor(element: Element) {
    this.#element = element
    this.#source = element.getAttribute(SOURCE_ATTRIBUTE)
    this.#index = [...document.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)].filter((el) => el.getAttribute(SOURCE_ATTRIBUTE) === this.#source).indexOf(element)
    const location = this.#location()
    this.#ready = location ? fetchFile(location.path, DEFAULT_SETTINGS).then((report) => { this.#hash = report.hash }).catch((error) => {
      this.error = error instanceof Error ? error.message : String(error)
      this.#notify()
    }) : Promise.resolve()
  }
  #location(): { path: string; line: number; column: number } | null {
    const match = /^(.+):(\d+):(\d+)$/.exec(this.#source ?? '')
    return match ? { path: match[1]!, line: Number(match[2]), column: Number(match[3]) } : null
  }
  #check(): void {
    if (this.saving) throw new Error('Wait for the current edit to finish saving.')
    if (!this.#source) throw new Error('This element has no Beast source location. Enable source tagging to save edits.')
  }
  async #save(change: Pick<ElementEditRequest, 'group' | 'name' | 'value' | 'declarations' | 'cssText'>): Promise<void> {
    await this.#ready
    const location = this.#location()
    if (!location || !this.#hash) throw new Error(this.error ?? 'The source file could not be loaded. Pick the element again.')
    const previous = this.#hash
    const result = await saveElementEdit({ ...location, hash: previous, tag: this.element.localName, ...change })
    this.#hash = result.hash
    this.#saved.push({ id: result.undoId, hash: previous })
    if (this.#saved.length > MAX_UNDO_STEPS) this.#saved.shift()
    if (this.#undo.length > MAX_UNDO_STEPS) this.#undo.shift()
  }
  async edit(group: ElementPropertyGroup, name: string, value: string | null): Promise<void> {
    this.#check()
    const version = this.#version
    this.#editLive(group, name, value)
    if (this.#version === version) return
    this.saving = true
    this.error = null
    this.#notify()
    try {
      await this.#save({ group, name, value: group === 'properties' ? Reflect.get(this.element, name) as string | number | boolean : value,
        ...(group === 'styles' ? { declarations: { [name]: value }, cssText: inlineStyle(this.element).cssText } : {}) })
    } catch (error) {
      this.#undo.pop()?.()
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally { this.saving = false; this.#notify() }
  }
  get canSave(): boolean { return this.#source !== null }
  get undoCount(): number { return this.#saved.length }
  capture(): ElementSnapshot { return captureElement(this.element) }

  #pushUndo(step: () => void): void {
    this.#version++
    this.#undo.push(step)
  }

  #editLive(group: ElementPropertyGroup, name: string, value: string | null): void {
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
      this.#pushUndo(() => {
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
      this.#pushUndo(() => { if (before === null) element.removeAttribute(name); else element.setAttribute(name, before) })
    } else {
      const property = this.capture().properties.find((entry) => entry.name === name)
      if (!property?.editable || value === null) throw new Error('This DOM property is read-only.')
      const next = property.type === 'boolean' ? value === 'true' : property.type === 'number' ? Number(value) : value
      if (property.type === 'number' && !Number.isFinite(next)) throw new Error('Enter a finite number.')
      if (property.type === 'boolean' && value !== 'true' && value !== 'false') throw new Error('Use true or false.')
      const before = Reflect.get(element, name)
      if (Object.is(before, next)) return
      if (!Reflect.set(element, name, next)) throw new Error('This DOM property could not be changed.')
      this.#pushUndo(() => { Reflect.set(element, name, before) })
    }
  }

  /** Live inline-style changes, such as a drag, that land as one undo step. */
  beginStyleEdit(): StyleEdit {
    this.#check()
    const declarations: Record<string, string> = {}
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
      set: (values) => {
        if (!done) for (const [name, value] of Object.entries(values)) { declarations[name] = value; style.setProperty(name, value) }
      },
      commit: async () => {
        if (done) return
        done = true
        if (element.getAttribute('style') === before) return
        this.saving = true
        this.error = null
        this.#notify()
        try {
          await this.#save({ group: 'styles', name: '', value: null, declarations, cssText: style.cssText })
          this.#pushUndo(restore)
          if (this.#undo.length > MAX_UNDO_STEPS) this.#undo.shift()
        } catch (error) {
          restore()
          this.error = error instanceof Error ? error.message : String(error)
          throw error
        } finally { this.saving = false; this.#notify() }
      },
      cancel: () => {
        if (done) return
        done = true
        restore()
      },
    }
  }

  async undo(): Promise<void> {
    this.#check()
    const saved = this.#saved.at(-1)
    if (!saved) return
    this.saving = true
    this.error = null
    this.#notify()
    try {
      await undoRefactor(saved.id)
      this.#hash = saved.hash
      this.#saved.pop()
      this.#undo.pop()?.()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally { this.saving = false; this.#notify() }
  }
}
