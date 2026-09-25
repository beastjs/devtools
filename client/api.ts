import {
  API_BASE,
  SOURCE_CHANGED_EVENT,
  type AnalyzerSettings,
  type FileReport,
  type ProjectReport,
} from '../shared/types.ts'

async function get<T>(endpoint: string, params: Record<string, string | number>): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
  const response = await fetch(`${API_BASE}${endpoint}?${query}`)
  const body = (await response.json()) as T | { error: string }
  if (!response.ok) throw new Error((body as { error: string }).error ?? response.statusText)
  return body as T
}

export function fetchProject(settings: AnalyzerSettings): Promise<ProjectReport> {
  return get<ProjectReport>('/project', { ...settings })
}

export function fetchFile(path: string, settings: AnalyzerSettings): Promise<FileReport> {
  return get<FileReport>('/file', { path, ...settings })
}

/** Called with the project-relative path whenever a `.btsx` file changes on disk. */
export function onSourceChanged(listener: (path: string) => void): () => void {
  const hot = import.meta.hot
  if (hot === undefined) return () => {}
  const handler = (data: { path: string }) => listener(data.path)
  hot.on(SOURCE_CHANGED_EVENT, handler)
  return () => hot.off(SOURCE_CHANGED_EVENT, handler)
}

/** Ask Vite's built-in launch-editor endpoint to open a file at a position. */
export function openInEditor(absolutePath: string, line = 1, column = 1): void {
  void fetch(`/__open-in-editor?file=${encodeURIComponent(`${absolutePath}:${line}:${column}`)}`)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
