/** CodeView's editable surface. Highlighting and fold boundaries stay shared with its reader. */
import { Annotation, Compartment, EditorState, Prec, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { codeFolding, foldAll, unfoldAll, foldGutter, foldKeymap, foldService, indentService, indentUnit } from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import { Vim, vim } from '@replit/codemirror-vim'
import { highlight, type Language } from './highlight.ts'
import { codeFolds } from './code-folds.ts'

export interface CodeEditorOptions {
  source: string
  language: Language
  firstLineNumber: number
  label: string
  vim: boolean
  disabled: boolean
  onChange: (source: string) => void
  onBlur?: () => void
  onSave?: (source: string) => void
}

const externalChange = Annotation.define<boolean>()
const saves = new WeakMap<EditorView, () => void>()
Vim.defineEx('write', 'w', (cm) => saves.get(cm.cm6)?.())

/** Distinguishes delayed echoes of typing from actual source replacements. */
export class EditorDocumentSync {
  #source: string
  #pending: string[] = []
  constructor(source: string) { this.#source = source.replace(/\r\n?/g, '\n') }
  edited(source: string): void { this.#pending.push(source) }
  receive(source: string): boolean {
    const changed = this.#source !== source
    this.#source = source
    const acknowledged = this.#pending.indexOf(source)
    if (acknowledged !== -1) this.#pending.splice(0, acknowledged + 1)
    else if (changed) this.#pending.length = 0
    return changed && acknowledged === -1
  }
}

function decorations(state: EditorState, language: Language): DecorationSet {
  const ranges = highlight(state.doc.toString(), language).flatMap((tokens, index) => {
    let position = state.doc.line(index + 1).from
    return tokens.flatMap((token) => {
      const from = position
      position += token.value.length
      return token.type === 'text' || position === from ? [] : [Decoration.mark({ class: `tk-${token.type}` }).range(from, position)]
    })
  })
  return Decoration.set(ranges)
}

/** Uses the same line-oriented BTSX/TSRX model as read-only CodeView. */
export function codeEditorLanguage(language: Language): Extension {
  const folds = StateField.define<Map<number, number>>({
    create: (state) => codeFolds(state.doc.toString(), language),
    update: (value, transaction) => transaction.docChanged ? codeFolds(transaction.state.doc.toString(), language) : value,
  })
  const tokens = StateField.define<DecorationSet>({
    create: (state) => decorations(state, language),
    update: (value, transaction) => transaction.docChanged ? decorations(transaction.state, language) : value,
    provide: (field) => EditorView.decorations.from(field),
  })
  return [
    folds, tokens, indentUnit.of('  '), EditorState.tabSize.of(2),
    foldService.of((state, from) => {
      const line = state.doc.lineAt(from)
      const end = state.field(folds).get(line.number)
      return end === undefined ? null : { from: line.to, to: state.doc.line(end).to }
    }),
    indentService.of((context, position) => {
      const before = context.lineAt(position, -1)
      const indent = context.countColumn(before.text, /^\s*/.exec(before.text)![0].length)
      // Template lines open a nested block; code statements keep their margin unless they open a brace.
      const content = before.text.trim()
      const opens = language === 'btsx' && /^(?:[A-Z\w.#-]+(?:\(|$)|(?:component|each|if|elseif|else|module|setup|style|scope|switch|case|default|try|catch|pending|empty|fragment)\b)/.test(content)
      return indent + (opens && !/;\s*$/.test(content) || /[{[(]\s*$/.test(content) ? 2 : 0)
    }),
  ]
}

export function createCodeEditor(parent: HTMLElement, initial: CodeEditorOptions) {
  let options = initial
  // Octane may echo a change after the next keystroke. Acknowledging an older
  // edit must not replace the newer document already held by CodeMirror.
  const documentSync = new EditorDocumentSync(initial.source)
  const vimMode = new Compartment()
  const accessibility = new Compartment()
  const numbers = new Compartment()
  const access = (): Extension => [
    EditorState.readOnly.of(options.disabled), EditorView.editable.of(!options.disabled),
    EditorView.contentAttributes.of({ 'aria-label': options.label, 'aria-readonly': String(options.disabled), spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off' }),
  ]
  const numbering = () => lineNumbers({ formatNumber: (line) => String(line + options.firstLineNumber - 1) })
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initial.source,
      extensions: [
        vimMode.of(options.vim ? vim({ status: true }) : []),
        accessibility.of(access()), numbers.of(numbering()),
        codeEditorLanguage(options.language),
        history(), drawSelection(), dropCursor(), highlightActiveLine(), highlightActiveLineGutter(),
        codeFolding({
          preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
          placeholderDOM: (_view, onclick, count: number) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'cm-foldPlaceholder'
            button.textContent = ` … ${count} lines`
            button.setAttribute('aria-label', `Expand ${count} folded lines`)
            button.addEventListener('click', onclick)
            return button
          },
        }),
        foldGutter({
          markerDOM: (open) => {
            const marker = document.createElement('span')
            marker.textContent = open ? '⌄' : '›'
            marker.title = open ? 'Collapse code block' : 'Expand code block'
            return marker
          },
        }),
        search({ top: true }),
        Prec.highest(keymap.of([{ key: 'Mod-s', run: () => { if (!options.disabled) options.onSave?.(view.state.doc.toString()); return true } }])),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
        EditorView.domEventHandlers({
          blur: (event) => { if (!view.dom.contains(event.relatedTarget as Node | null)) options.onBlur?.() },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(externalChange))) {
            const source = update.state.doc.toString()
            documentSync.edited(source)
            options.onChange(source)
          }
        }),
      ],
    }),
  })
  saves.set(view, () => { if (!options.disabled) options.onSave?.(view.state.doc.toString()) })
  return {
    view,
    collapseAll: () => { foldAll(view) },
    expandAll: () => { unfoldAll(view) },
    update(next: CodeEditorOptions) {
      const previous = options
      options = next
      const effects = []
      if (previous.vim !== next.vim) effects.push(vimMode.reconfigure(next.vim ? vim({ status: true }) : []))
      if (previous.disabled !== next.disabled || previous.label !== next.label) effects.push(accessibility.reconfigure(access()))
      if (previous.firstLineNumber !== next.firstLineNumber) effects.push(numbers.reconfigure(numbering()))
      const current = view.state.doc.toString()
      const source = next.source.replace(/\r\n?/g, '\n')
      const replace = documentSync.receive(source)
      // Patch only the changed span so indentation normalization preserves cursors and folds.
      let from = 0
      while (from < current.length && from < source.length && current[from] === source[from]) from++
      let oldEnd = current.length, newEnd = source.length
      while (oldEnd > from && newEnd > from && current[oldEnd - 1] === source[newEnd - 1]) { oldEnd--; newEnd-- }
      if (replace && current !== source || effects.length) view.dispatch({
        changes: !replace || current === source ? undefined : { from, to: oldEnd, insert: source.slice(from, newEnd) },
        effects, annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
      })
    },
    destroy() { saves.delete(view); view.destroy() },
  }
}

const VIM_KEY = 'beast-devtools:vim'
export function loadVimMode(): boolean {
  try { return localStorage.getItem(VIM_KEY) === 'true' } catch { return false }
}
export function storeVimMode(enabled: boolean): void {
  try { localStorage.setItem(VIM_KEY, String(enabled)) } catch { /* Optional preference. */ }
}
