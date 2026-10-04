import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { classRanges, toggleClassOverrides } from './class-folds.ts'
import type { Language } from './highlight.ts'

export const collapseClasses = StateEffect.define<boolean>()
export const expandClass = StateEffect.define<number>()
export const toggleClassAttribute = StateEffect.define<number>()

class ClassWidget extends WidgetType {
  constructor(readonly from: number, readonly text: string) { super() }
  eq(other: ClassWidget) { return other.from === this.from && other.text === this.text }
  toDOM(view: EditorView) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'bdt-class-fold'
    button.textContent = '…'
    button.title = this.text
    button.setAttribute('aria-label', 'Expand Tailwind classes')
    button.setAttribute('aria-expanded', 'false')
    button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); view.dispatch({ effects: expandClass.of(this.from) }) })
    return button
  }
  ignoreEvent() { return true }
}

interface ClassFoldState { collapsed: boolean; overrides: Map<number, boolean>; decorations: DecorationSet; folds: DecorationSet }
export function editorClassFolding(language: Language, initiallyCollapsed = false): Extension {
  const render = (state: EditorState, collapsed: boolean, overrides: Map<number, boolean>): ClassFoldState => {
    const ranges = classRanges(state.doc.toString(), language)
    const folds = ranges.filter((range) => overrides.get(range.from) ?? collapsed)
      .map((range) => Decoration.replace({ widget: new ClassWidget(range.from, range.text) }).range(range.from, range.to))
    const keywords = [...new Map(ranges.map((range) => [range.keywordFrom, range])).values()]
      .map((range) => Decoration.mark({ class: 'bdt-class-keyword', attributes: {
        'data-class-keyword': String(range.keywordFrom), title: 'Double-click to expand or collapse classes',
      } }).range(range.keywordFrom, range.keywordTo))
    return { collapsed, overrides, folds: Decoration.set(folds), decorations: Decoration.set([...keywords, ...folds], true) }
  }
  const field = StateField.define<ClassFoldState>({
    create: (state) => render(state, initiallyCollapsed, new Map()),
    update: (previous, transaction) => {
      let collapsed = previous.collapsed
      let overrides = transaction.docChanged ? new Map([...previous.overrides].map(([from, value]) => [transaction.changes.mapPos(from), value])) : previous.overrides
      let changed = transaction.docChanged
      for (const effect of transaction.effects) {
        if (effect.is(collapseClasses)) { collapsed = effect.value; overrides = new Map(); changed = true }
        if (effect.is(expandClass)) { overrides = new Map(overrides).set(effect.value, false); changed = true }
        if (effect.is(toggleClassAttribute)) { overrides = toggleClassOverrides(classRanges(transaction.state.doc.toString(), language), collapsed, overrides, effect.value); changed = true }
      }
      // Searches and Vim motions may place the cursor inside a hidden list; reveal it for editing.
      if (transaction.selection) {
        for (const range of classRanges(transaction.state.doc.toString(), language)) {
          if ((overrides.get(range.from) ?? collapsed) && transaction.newSelection.ranges.some((selection) => selection.empty && range.from < selection.head && selection.head < range.to)) {
            overrides = new Map(overrides).set(range.from, false); changed = true
          }
        }
      }
      return changed ? render(transaction.state, collapsed, overrides) : previous
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  })
  return [field, EditorView.atomicRanges.of((view) => view.state.field(field).folds), Prec.highest(EditorView.domEventHandlers({
    dblclick: (event, view) => {
      const keyword = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-class-keyword]') : null
      if (!keyword) return false
      event.preventDefault(); event.stopPropagation()
      view.dispatch({ effects: toggleClassAttribute.of(Number(keyword.dataset.classKeyword)) })
      return true
    },
  }))]
}
