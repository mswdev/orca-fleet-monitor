// Finding the Orca CLI from inside a worker, and running it with a timeout and an output cap.
//
// A worker is Orca's own Electron binary running as Node (ELECTRON_RUN_AS_NODE=1) with a cut-down
// environment, so the launcher Orca ships beside its resources is the most reliable target.
// Orca's own layout (see getBundledLauncherPath in Orca's source):
//   macOS    <resources>/bin/orca       (a bash wrapper)
//   Linux    <resources>/bin/orca-ide   (Linux avoids `orca`, which GNOME's screen reader owns)
//   Windows  <resources>\bin\orca.exe   (orca.cmd needs a shell, so it is never used here)
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
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

/** Launcher names inside Orca's own folders (its resources), where `orca` can only be Orca's. */
function bundledNames(platform: string): string[] {
  if (platform === 'win32') return ['orca.exe']
  if (platform === 'linux') return ['orca-ide', 'orca']
  return ['orca']
}

/** Launcher names looked for on PATH. Not a plain `orca` on Linux: there it is usually GNOME's
 *  screen reader, which is why Orca's desktop install names its launcher `orca-ide`. */
function pathNames(platform: string): string[] {
  if (platform === 'win32') return ['orca.exe']
  if (platform === 'linux') return ['orca-ide']
  return ['orca']
}

/** What a person types to run Orca's CLI on a machine of this platform (as Orca's own
 *  getOrcaCliCommandNameForPlatform names it): `orca-ide` on Linux desktops, `orca` elsewhere
 *  (on Windows, PATHEXT finds `orca.cmd`). */
export function cliLauncherName(platform: string): 'orca' | 'orca-ide' {
  return platform === 'linux' ? 'orca-ide' : 'orca'
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

/** The CLI path setting as typed, less the quotes Windows' "Copy as path" wraps a path in. */
function unquoted(value: string | null | undefined): string {
  const text = value?.trim() ?? ''
  const quoted = /^"(.*)"$/.exec(text) ?? /^'(.*)'$/.exec(text)
  return quoted ? quoted[1]!.trim() : text
}

/** Every place the CLI may be, best first. Pure: no file system access. */
export function cliCandidates(env: CliEnvironment): CliCandidate[] {
  const p = env.platform === 'win32' ? path.win32 : path.posix
  const out: CliCandidate[] = []
  const add = (file: string | null, source: string): void => {
    if (file && !out.some((c) => c.path === file)) out.push({ path: file, source })
  }
  const override = unquoted(env.override)
  // A setting that names Windows' `orca.cmd` means the `orca.exe` beside it: a .cmd cannot be run
  // without a shell (spawn EINVAL), and it only passes its arguments on to that .exe anyway.
  const cmdShim = env.platform === 'win32' && override ? /^(.*[\\/])orca\.cmd$/i.exec(override) : null
  if (override) add(cmdShim ? `${cmdShim[1]}orca.exe` : override, 'setting')

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
    for (const name of bundledNames(env.platform)) add(p.join(dir, 'bin', name), source)
  }

  // A headless Orca server (orcad) writes its launcher under its data folder; workers never see
  // XDG_DATA_HOME or ORCA_USER_DATA, so only the default location is reachable.
  if (env.home && env.platform !== 'win32') add(p.join(env.home, '.orca', 'cli', 'bin', 'orca'), 'server launcher')

  const delimiter = env.platform === 'win32' ? ';' : ':'
  for (const dir of (env.pathEnv ?? '').split(delimiter)) {
    if (!dir || !p.isAbsolute(dir)) continue // a relative PATH entry would run from the cwd
    for (const name of pathNames(env.platform)) add(p.join(dir, name), 'PATH')
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
    // Windows runs only an .exe without a shell; a script would fail every call with spawn EINVAL.
    if (candidate.source === 'setting' && env.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate.path)) {
      return { path: null, source: 'setting', tried, error: `The CLI path in settings must be an .exe on Windows, not a script: ${candidate.path}` }
    }
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

/**
 * The environment the CLI runs in. Orca starts a worker with a short list of variables, and the
 * one that says where Orca keeps its data is not on it. Orca's CLI needs that to find the running
 * app, so it is put back:
 *   Windows  APPDATA. Without it the CLI stops with "APPDATA is not set". Read from where this
 *            plugin is installed, else its default place under the user's profile.
 *   Linux    XDG_CONFIG_HOME, only when this plugin is installed somewhere other than the default
 *            `~/.config/orca`, which is where the CLI looks without it.
 * Everything else, and macOS, passes through.
 */
export function cliProcessEnv(env: NodeJS.ProcessEnv, platform: string, pluginFile: string | null = null): NodeJS.ProcessEnv {
  if (platform !== 'win32' && platform !== 'linux') return env
  const windows = platform === 'win32'
  const p = windows ? path.win32 : path.posix
  // Windows variable names ignore case, but a copied environment is a plain object that does not.
  const read = (name: string): string | undefined => {
    if (!windows) return env[name]
    const key = Object.keys(env).find((k) => k.toUpperCase() === name)
    return key === undefined ? undefined : env[key]
  }
  // Orca's data folder is `orca` inside the folder the variable names.
  const dataDir = orcaDataDirFromPluginFile(pluginFile)
  const named = dataDir && p.isAbsolute(dataDir) ? p.basename(dataDir) : null
  const configHome = dataDir && (windows ? named?.toLowerCase() === 'orca' : named === 'orca') ? p.dirname(dataDir) : null
  if (windows) {
    if (read('APPDATA')) return env
    const profile = read('USERPROFILE')
    const appData = configHome ?? (profile ? p.join(profile, 'AppData', 'Roaming') : null)
    return appData ? { ...env, APPDATA: appData } : env
  }
  if (read('XDG_CONFIG_HOME') || !configHome) return env
  const home = read('HOME')
  if (home && configHome === p.join(home, '.config')) return env
  return { ...env, XDG_CONFIG_HOME: configHome }
}

/**
 * Orca's data folder, read from where this plugin is installed. Orca keeps an installed plugin in
 * `<data folder>/plugins/<publisher>.<id>/<content hash, or "current">/`, so a file in there says
 * where the data folder really is, even when it has been moved. Null for a plugin run from
 * anywhere else (a dev folder), whatever its path happens to contain.
 */
export function orcaDataDirFromPluginFile(file: string | null): string | null {
  if (!file) return null
  const separator = file.includes('\\') ? '\\' : '/'
  const parts = file.split(/[\\/]+/)
  for (let i = parts.length - 3; i >= 1; i -= 1) {
    if (parts[i] === 'plugins' && /^[^.]+\..+$/.test(parts[i + 1]!) && /^([0-9a-f]{16,}|current)$/i.test(parts[i + 2]!)) {
      return parts.slice(0, i).join(separator) || null
    }
  }
  return null
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

export type Spawner = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/**
 * Ends a child and everything it started. A launcher may start the real CLI as its own child and
 * wait for it (Windows' `orca.exe` does), so killing the launcher alone leaves the CLI running,
 * still holding the output pipes. POSIX: the child leads its own process group (see `detached`
 * below), so the whole group is killed. Windows: `taskkill /T /F` ends the tree, run from the
 * system folder by its full path so nothing on PATH can stand in for it.
 */
export function killTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  platform: string = process.platform,
  deps: { spawn?: Spawner; kill?: (pid: number, signal: NodeJS.Signals) => void; systemRoot?: string | null } = {}
): void {
  const pid = child.pid
  if (pid === undefined) return
  if (platform === 'win32') {
    // taskkill walks the tree from the launcher, so the launcher must still be there: kill it
    // directly only if taskkill cannot run or fails.
    const fallback = (): void => {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    const root = deps.systemRoot ?? process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const taskkill = path.win32.join(root, 'System32', 'taskkill.exe')
    try {
      const killer = (deps.spawn ?? spawn)(taskkill, ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      })
      killer.on('error', fallback)
      killer.on('exit', (code) => {
        if (code !== 0) fallback()
      })
    } catch {
      fallback()
    }
    return
  }
  try {
    ;(deps.kill ?? process.kill)(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** Runs `file args...` without a shell. A call that times out, overflows the output cap or is
 *  stopped has its whole process tree killed and settles at once, without waiting for the
 *  processes to close their pipes. `stop()` does that to everything still running. */
export function createProcessRunner(
  file: () => string | null,
  options: {
    maxOutputBytes?: number
    env?: NodeJS.ProcessEnv
    /** A file of this plugin's own, which says where Orca's data folder is (see `cliProcessEnv`). */
    pluginFile?: string | null
    now?: () => number
    platform?: string
    spawn?: Spawner
    killTree?: (child: ChildProcess) => void
  } = {}
): { run: CommandRunner; stop: () => void; running: () => number } {
  const running = new Map<ChildProcess, () => void>()
  // Worked out once: neither the worker's environment nor where the plugin is changes.
  let cliEnv: NodeJS.ProcessEnv | null = null
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const now = options.now ?? Date.now
  const platform = options.platform ?? process.platform
  const spawnChild = options.spawn ?? spawn
  const kill = options.killTree ?? ((child: ChildProcess) => killTree(child, platform))
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
        child = spawnChild(target, [...args], {
          env: (cliEnv ??= cliProcessEnv(options.env ?? process.env, platform, options.pluginFile ?? null)),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
          // Its own process group on POSIX, so the whole tree can be killed at once. (On Windows
          // this would open a console window instead; taskkill /T finds the tree there.)
          detached: platform !== 'win32'
        })
      } catch (error) {
        done({ spawnError: error instanceof Error ? error.message : String(error) })
        return
      }
      const out: Buffer[] = []
      const err: Buffer[] = []
      let bytes = 0
      let truncated = false
      let timedOut = false
      let spawnError: string | null = null
      const finish = (code: number | null): void => {
        if (settled) return
        clearTimeout(timer)
        running.delete(child)
        done({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          timedOut,
          truncated,
          spawnError
        })
      }
      /** Kills the tree and settles now: a grandchild may keep the pipes open long after. */
      const abandon = (): void => {
        if (settled) return
        kill(child)
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(null)
      }
      running.set(child, abandon)
      const collect = (sink: Buffer[]) => (chunk: Buffer) => {
        if (settled) return
        if (bytes + chunk.length > maxBytes) {
          truncated = true
          abandon()
          return
        }
        bytes += chunk.length
        sink.push(chunk)
      }
      child.stdout?.on('data', collect(out))
      child.stderr?.on('data', collect(err))
      // A destroyed pipe may report an error; the result is already settled by then.
      child.stdout?.on('error', () => {})
      child.stderr?.on('error', () => {})
      const timer = setTimeout(() => {
        timedOut = true
        abandon()
      }, runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS)
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
      for (const abandon of [...running.values()]) abandon()
      running.clear()
    },
    running: () => running.size
  }
}
