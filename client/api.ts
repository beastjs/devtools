import {
  API_BASE,
  SOURCE_CHANGED_EVENT,
  type AnalyzerSettings,
  type ApplyRequest,
  type ContinuationRequest,
  type ApplyResult,
  type FileReport,
  type ProjectReport,
  type UndoResult,
} from '../shared/types.ts'

async function get<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
  const response = await fetch(`${API_BASE}${endpoint}?${query}`)
  const body = (await response.json()) as T | { error: string }
  if (!response.ok) throw new Error((body as { error: string }).error ?? response.statusText)
  return body as T
}

async function post<T>(endpoint: string, body: unknown, project = ''): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}?${new URLSearchParams({ project })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = (await response.json()) as T | { error: string }
  if (!response.ok) throw new Error((result as { error: string }).error ?? response.statusText)
  return result as T
}

export function fetchProject(settings: AnalyzerSettings, project = ''): Promise<ProjectReport> {
  return get<ProjectReport>('/project', { ...settings, project })
}

export function fetchFile(path: string, settings: AnalyzerSettings, project = ''): Promise<FileReport> {
  return get<FileReport>('/file', { path, ...settings, project })
}

/** Preview (`dryRun`) or write a refactor suggestion. */
export function applyRefactor(request: ApplyRequest, project = ''): Promise<ApplyResult> {
  return post<ApplyResult>('/apply', request, project)
}

export function undoRefactor(id: string, project = ''): Promise<UndoResult> {
  return post<UndoResult>('/undo', { id }, project)
}

/** Called with the project-relative path whenever a `.btsx` file changes on disk. */
export function onSourceChanged(listener: (path: string) => void): () => void {
  // Server-sent events work the same under every dev server, unlike each bundler's HMR channel.
  const events = new EventSource(`${API_BASE}/events`)
  events.addEventListener(SOURCE_CHANGED_EVENT, (event) => listener((JSON.parse(event.data) as { path: string }).path))
  return () => events.close()
}

/**
 * Open a file at a position; the API forwards to the dev server's launch-editor
 * endpoint. `path` is absolute or relative to the project root.
 */
export function openInEditor(path: string, line = 1, column = 1): void {
  void fetch(`${API_BASE}/open-in-editor?file=${encodeURIComponent(`${path}:${line}:${column}`)}`)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function openProject(path: string): Promise<{ id: string; root: string }> {
  return post('/open-project', { path })
}

export function browseProject(): Promise<{ path: string | null }> {
  return post('/browse-project', {})
}

export function fetchSelection(path: string, line: number, settings: AnalyzerSettings, project = ''): Promise<FileReport> {
  return get('/file', { path, line, ...settings, project })
}

export function continueProps(request: ContinuationRequest, project = ''): Promise<ApplyResult> {
  return post<ApplyResult>('/continue-props', request, project)
}

export function saveElementEdit(request: import('../shared/types.ts').ElementEditRequest): Promise<import('../shared/types.ts').ElementEditResult> {
  // Picked DOM elements always belong to the running app, not a browsed project.
  return post('/element-edit', request)
}

export function fetchSourceBlock(selection: import('../shared/types.ts').SourceBlockSelection): Promise<import('../shared/types.ts').SourceBlockReport> {
  return get('/source-block', { ...selection })
}

export function saveBlockEdit(request: import('../shared/types.ts').BlockEditRequest): Promise<import('../shared/types.ts').BlockEditResult> {
  return post('/block-edit', request)
}
