import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
type RunDialog = (command: string, args: string[]) => Promise<{ stdout: string }>
const runDialog: RunDialog = (command, args) => execute(command, args, { encoding: 'utf8', timeout: 300_000 })

/** Native dialogs run on the dev-server machine; never interpolate paths into scripts. */
export function createFolderBrowser(platform: string = process.platform, run: RunDialog = runDialog): () => Promise<string | null> {
  let pending: Promise<string | null> | null = null
  const choose = async (): Promise<string | null> => {
    try {
      let output: { stdout: string }
      if (platform === 'darwin') {
        output = await run('/usr/bin/osascript', ['-e', [
          'try',
          'activate',
          'return POSIX path of (choose folder with prompt "Open project folder")',
          'on error number -128',
          'return ""',
          'end try',
        ].join('\n')])
      } else if (platform === 'win32') {
        output = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
          '$dialog.Description = "Open project folder"',
          '$dialog.ShowNewFolderButton = $false',
          'try { if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) } } finally { $dialog.Dispose() }',
        ].join('; ')])
      } else if (platform === 'linux') {
        try {
          output = await run('zenity', ['--file-selection', '--directory', '--title=Open project folder'])
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          output = await run('kdialog', ['--getexistingdirectory', '.', '--title', 'Open project folder'])
        }
      } else {
        throw new Error('Unsupported platform')
      }
      return output.stdout.replace(/[\r\n]+$/, '') || null
    } catch (error) {
      // Linux folder dialogs use exit status 1 when dismissed.
      if (platform === 'linux' && (error as { code?: unknown }).code === 1 && !(error as { stderr?: string }).stderr?.trim()) return null
      throw new Error('Could not open the native folder chooser on the dev-server machine. Enter the folder path manually.')
    }
  }
  // Multiple clicks or browser tabs share the currently open native dialog.
  return () => pending ??= choose().finally(() => { pending = null })
}
