/**
 * Wire types shared by the dev-server API (`devtools/server`) and the in-page
 * overlay (`devtools/client`). Everything here must stay JSON-serializable.
 */

export const API_BASE = '/__beast-devtools/api'
export const SOURCE_CHANGED_EVENT = 'beast-devtools:source-changed'

export interface AnalyzerSettings {
  /** Template nesting depth (0 = component root) above which a line counts as too deep. */
  depthLimit: number
  /** Smallest section, in source lines, worth extracting into a component. */
  minLines: number
  /** Sections at least this long are extracted into their own `.btsx` file by default. */
  fileLines: number
}

export const DEFAULT_SETTINGS: AnalyzerSettings = { depthLimit: 5, minLines: 8, fileLines: 30 }

export type Severity = 'info' | 'warning' | 'critical'

export interface LineRange {
  startLine: number
  endLine: number
}

export interface SuggestedProp {
  name: string
  type: string
}

export interface RefactorSuggestion extends LineRange {
  id: string
  kind: 'extract' | 'duplicate'
  severity: Severity
  /** Component (default or local `component`) the section currently lives in. */
  host: string
  /** Proposed PascalCase name for the new local component. */
  name: string
  /** Selector-style label of the section root, e.g. `section#workflow-panel`. */
  label: string
  reason: string
  lines: number
  /** Nesting depth of the section root inside its host. */
  depth: number
  /** Deepest nesting depth reached inside the section, measured in the host. */
  reach: number
  props: SuggestedProp[]
  /** Ready-to-paste `component` declaration. */
  snippet: string
  /** Call site that replaces the section. */
  usage: string
  /** Line before which the `component` declaration should be inserted. */
  insertBeforeLine: number
  /** Every structurally identical copy (duplicate suggestions only). */
  occurrences: LineRange[]
  /** Identifiers and component tags the section references, for moving it to another file. */
  references: string[]
  autoApply: AutoApply
}

export type RefactorTarget = 'inline' | 'file'

/** Whether the suggestion can be applied automatically, and where by default. */
export interface AutoApply {
  /** Default target: sections of `fileLines` or more go to their own file. */
  target: RefactorTarget
  /** Why the suggestion cannot be applied at all, if so. */
  blocked: string | null
  /** Why the section cannot move to its own file, if so. */
  fileBlocked: string | null
}

export interface ComponentMetrics {
  name: string
  line: number
  templateLines: number
  maxDepth: number
}

export interface FileAnalysis {
  settings: AnalyzerSettings
  /** Detected indentation step in spaces. */
  indentUnit: number
  /** Structural nesting depth per source line (index = line - 1); `null` outside templates. */
  lineDepths: Array<number | null>
  maxDepth: number
  averageDepth: number
  templateLines: number
  /** Template lines deeper than `settings.depthLimit`. */
  deepLines: number
  /** Number of template lines at each depth (index = depth). */
  histogram: number[]
  components: ComponentMetrics[]
  suggestions: RefactorSuggestion[]
}

export interface DiagnosticInfo {
  code: string
  severity: 'error' | 'warning'
  message: string
  line: number
  column: number
  endLine: number
  endColumn: number
  hint?: string
  /** Human-readable rendering with a caret under the failing source. */
  formatted: string
}

export type CompiledOutput =
  | {
      ok: true
      tsrx: string
      /** BTSX line (index = line - 1) for each generated TSRX line; `null` when unmapped. */
      tsrxToBtsx: Array<number | null>
      /** Generated TSRX lines for each BTSX line (index = line - 1). */
      btsxToTsrx: number[][]
      diagnostics: DiagnosticInfo[]
    }
  | { ok: false; error: DiagnosticInfo }

export interface FileSummary {
  path: string
  lines: number
  maxDepth: number | null
  deepLines: number
  suggestions: number
  error: string | null
}

export interface HookBinding {
  /** Hook call, e.g. `useState`. */
  hook: string
  /** Names bound by the declaration, e.g. `['activeId', 'setActiveId']`. */
  names: string[]
  line: number
}

export interface ComponentLocation {
  name: string
  path: string
  absolutePath: string
  line: number
  column: number
  local: boolean
  /** Value-bearing hooks declared in setup, in call order. */
  hooks: HookBinding[]
}

export interface ProjectReport {
  root: string
  settings: AnalyzerSettings
  files: FileSummary[]
  components: ComponentLocation[]
}

export interface FileReport {
  path: string
  absolutePath: string
  /** Content hash; refactors are refused when the file changed since it was analyzed. */
  hash: string
  source: string
  compiled: CompiledOutput
  analysis: FileAnalysis | null
}

export interface ApplyRequest {
  path: string
  hash: string
  settings: AnalyzerSettings
  suggestionId: string
  target: RefactorTarget
  /** Plan and validate without writing. */
  dryRun: boolean
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove'
  text: string
}

export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface PlannedFile {
  path: string
  action: 'create' | 'edit'
  added: number
  removed: number
  hunks: DiffHunk[]
}

export interface ApplyResult {
  /** Undo handle; present once the change has been written. */
  undoId: string | null
  /** Name of the extracted component. */
  component: string
  summary: string
  files: PlannedFile[]
}

export interface UndoResult {
  summary: string
}
