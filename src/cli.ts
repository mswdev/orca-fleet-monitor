// Finding the Orca CLI from inside a worker, and running it with a timeout and an output cap.
//
// A worker is Orca's own Electron binary running as Node (ELECTRON_RUN_AS_NODE=1) with a cut-down
// environment, so the launcher Orca ships beside its resources is the most reliable target.
// Orca's own layout (see getBundledLauncherPath in Orca's source):
//   macOS    <resources>/bin/orca       (a bash wrapper)
//   Linux    <resources>/bin/orca-ide   (Linux avoids `orca`, which GNOME's screen reader owns)
//   Windows  <resources>\bin\orca.exe   (orca.cmd needs a shell, so it is never used here)
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'

export type CliCandidate = { path: string; source: string }

export type CliEnvironment = {
  platform: string
  resourcesPath?: string | null
  execPath?: string | null
  /** The worker's entry script; Orca forks it from `<resources>/app.asar.unpacked/...`. */
  entryScript?: string | null
  home?: string | null
  pathEnv?: string | null
  override?: string | null
}

function launcherNames(platform: string): string[] {
  if (platform === 'win32') return ['orca.exe']
  if (platform === 'linux') return ['orca-ide', 'orca']
  return ['orca']
}

function resourcesFromExecPath(platform: string, execPath: string, p: typeof path.posix): string | null {
  if (platform === 'darwin') {
    // <App>.app/Contents/MacOS/<binary> -> <App>.app/Contents/Resources
    const macos = p.dirname(execPath)
    return p.basename(macos) === 'MacOS' ? p.join(p.dirname(macos), 'Resources') : null
  }
  // Linux and Windows Electron apps keep `resources` next to the binary.
  return p.join(p.dirname(execPath), 'resources')
}

function resourcesFromEntry(entry: string, p: typeof path.posix): string | null {
  const marker = 'app.asar.unpacked'
  const parts = entry.split(/[\\/]/)
  const index = parts.lastIndexOf(marker)
  if (index <= 0) return null
  const joined = parts.slice(0, index).join(p.sep)
  return joined || p.sep
}

/** Every place the CLI may be, best first. Pure: no file system access. */
export function cliCandidates(env: CliEnvironment): CliCandidate[] {
  const p = env.platform === 'win32' ? path.win32 : path.posix
  const out: CliCandidate[] = []
  const add = (file: string | null, source: string): void => {
    if (file && !out.some((c) => c.path === file)) out.push({ path: file, source })
  }
  const override = env.override?.trim()
  if (override) add(override, 'setting')

  const resourceDirs: { dir: string; source: string }[] = []
  if (env.resourcesPath) resourceDirs.push({ dir: env.resourcesPath, source: 'bundled' })
  if (env.entryScript) {
    const dir = resourcesFromEntry(env.entryScript, p)
    if (dir) resourceDirs.push({ dir, source: 'bundled (worker entry)' })
  }
  if (env.execPath) {
    const dir = resourcesFromExecPath(env.platform, env.execPath, p)
    if (dir) resourceDirs.push({ dir, source: 'bundled (exec path)' })
  }
  for (const { dir, source } of resourceDirs) {
    for (const name of launcherNames(env.platform)) add(p.join(dir, 'bin', name), source)
  }

  // A headless Orca server (orcad) writes its launcher under its data folder; workers never see
  // XDG_DATA_HOME or ORCA_USER_DATA, so only the default location is reachable.
  if (env.home && env.platform !== 'win32') add(p.join(env.home, '.orca', 'cli', 'bin', 'orca'), 'server launcher')

  const delimiter = env.platform === 'win32' ? ';' : ':'
  for (const dir of (env.pathEnv ?? '').split(delimiter)) {
    if (!dir || !p.isAbsolute(dir)) continue // a relative PATH entry would run from the cwd
    for (const name of launcherNames(env.platform)) add(p.join(dir, name), 'PATH')
  }

  if (env.platform === 'darwin') {
    add('/Applications/Orca.app/Contents/Resources/bin/orca', 'default install')
    if (env.home) add(p.join(env.home, 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'), 'default install')
    add('/usr/local/bin/orca', 'default install')
  }
  if (env.home && env.platform === 'linux') {
    add(p.join(env.home, '.local', 'bin', 'orca-ide'), 'default install')
  }
  if (env.home && env.platform === 'win32') {
    add(p.join(env.home, 'AppData', 'Local', 'Programs', 'Orca', 'resources', 'bin', 'orca.exe'), 'default install')
  }
  return out
}

export function isRunnable(file: string, platform: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export type CliResolution = { path: string | null; source: string | null; tried: string[]; error: string | null }

/** The first candidate that exists and can run. A setting that does not point at one is an
 *  error rather than silently ignored. */
export function resolveCli(
  env: CliEnvironment,
  runnable: (file: string, platform: string) => boolean = isRunnable
): CliResolution {
  const candidates = cliCandidates(env)
  const tried: string[] = []
  for (const candidate of candidates) {
    tried.push(candidate.path)
    if (runnable(candidate.path, env.platform)) {
      return { path: candidate.path, source: candidate.source, tried, error: null }
    }
    if (candidate.source === 'setting') {
      return { path: null, source: 'setting', tried, error: `The CLI path in settings cannot be run: ${candidate.path}` }
    }
  }
  return { path: null, source: null, tried, error: 'Could not find the Orca CLI; set its path in Fleet Monitor settings' }
}

/** The worker's own surroundings, for `resolveCli`. */
export function workerCliEnvironment(override: string | null): CliEnvironment {
  const resourcesPath = (process as { resourcesPath?: unknown }).resourcesPath
  return {
    platform: process.platform,
    resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : null,
    execPath: process.execPath,
    entryScript: process.argv[1] ?? null,
    home: process.env.HOME ?? process.env.USERPROFILE ?? null,
    pathEnv: process.env.PATH ?? process.env.Path ?? null,
    override
  }
}

export type CommandResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
  /** Set when the process could not start at all (ENOENT, EACCES, ...). */
  spawnError: string | null
}

export type CommandRunner = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<CommandResult>

export const DEFAULT_TIMEOUT_MS = 15_000
/** A full 200-line log ring at 8 KiB a line is about 1.6 MiB of JSON. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** Runs `file args...` without a shell. `stop()` kills everything still running. */
export function createProcessRunner(
  file: () => string | null,
  options: { maxOutputBytes?: number; env?: NodeJS.ProcessEnv; now?: () => number } = {}
): { run: CommandRunner; stop: () => void; running: () => number } {
  const children = new Set<ChildProcess>()
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const now = options.now ?? Date.now
  const run: CommandRunner = (args, runOptions = {}) =>
    new Promise<CommandResult>((resolve) => {
      const started = now()
      const target = file()
      let settled = false
      const done = (partial: Partial<CommandResult>): void => {
        if (settled) return
        settled = true
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          truncated: false,
          spawnError: null,
          ...partial,
          durationMs: now() - started
        })
      }
      if (!target) {
        done({ spawnError: 'Orca CLI not found' })
        return
      }
      let child: ChildProcess
      try {
        child = spawn(target, [...args], {
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false
        })
      } catch (error) {
        done({ spawnError: error instanceof Error ? error.message : String(error) })
        return
      }
      children.add(child)
      const out: Buffer[] = []
      const err: Buffer[] = []
      let bytes = 0
      let truncated = false
      let timedOut = false
      let spawnError: string | null = null
      const collect = (sink: Buffer[]) => (chunk: Buffer) => {
        if (bytes + chunk.length > maxBytes) {
          truncated = true
          child.kill('SIGKILL')
          return
        }
        bytes += chunk.length
        sink.push(chunk)
      }
      child.stdout?.on('data', collect(out))
      child.stderr?.on('data', collect(err))
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      const finish = (code: number | null): void => {
        clearTimeout(timer)
        children.delete(child)
        done({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
          truncated,
          spawnError
        })
      }
      child.on('error', (error) => {
        spawnError = error.message
        // A process that never started may not emit 'close'.
        if (child.pid === undefined) finish(null)
      })
      child.on('close', (code) => finish(code))
    })
  return {
    run,
    stop: () => {
      for (const child of children) child.kill('SIGKILL')
      children.clear()
    },
    running: () => children.size
  }
}
