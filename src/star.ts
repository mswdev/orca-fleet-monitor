// "Star on GitHub", done for the person who pressed it. GitHub has no link that stars a
// repository, so where the GitHub CLI (`gh`) is installed and signed in, the worker asks it to:
//
//   gh api --method PUT /user/starred/<owner>/<repository>
//
// It runs only when the panel's link is pressed, never by itself, and nothing is asked of GitHub
// before that: whether `gh` is there at all is a file's existence. Where it is missing, not signed
// in or refused, the panel opens the project's page instead, as it always did.
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { cliProcessEnv, isRunnable } from './cli.ts'
import { createRunBounded, type ExecFile } from './mac-memory.ts'

/** The one repository this can star: this plugin's own. Never taken from a setting or the panel. */
export const STAR_REPOSITORY = 'mswdev/orca-fleet-monitor'
export const STAR_ARGS = ['api', '--method', 'PUT', '-H', 'Accept: application/vnd.github+json', `/user/starred/${STAR_REPOSITORY}`] as const
const STAR_TIMEOUT_MS = 15_000
const STAR_MAX_BYTES = 64 * 1024
export const AVAILABLE_CACHE_MS = 60_000
/** `gh`'s own bounded runner, apart from the readers'. */
export const starRunBounded: ExecFile = createRunBounded()

/** Where `gh` may be, best first: PATH (full paths only, as for the Orca CLI), then where Homebrew
 *  and GitHub's installers put it, since a worker's PATH is the short one Orca gives it. */
export function ghCandidates(env: { platform: string; pathEnv?: string | null; home?: string | null; programFiles?: string | null }): string[] {
  const windows = env.platform === 'win32'
  const p = windows ? path.win32 : path.posix
  const name = windows ? 'gh.exe' : 'gh'
  const out: string[] = []
  const add = (file: string): void => {
    if (!out.includes(file)) out.push(file)
  }
  for (const dir of (env.pathEnv ?? '').split(windows ? ';' : ':')) {
    if (dir && p.isAbsolute(dir)) add(p.join(dir, name))
  }
  if (windows) {
    add(p.join(env.programFiles && p.isAbsolute(env.programFiles) ? env.programFiles : 'C:\\Program Files', 'GitHub CLI', name))
  } else {
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin']) add(p.join(dir, name))
    if (env.home && p.isAbsolute(env.home)) add(p.join(env.home, '.local', 'bin', name))
  }
  return out
}

/** The first candidate that is there and can run, or null. */
export function findGh(env: Parameters<typeof ghCandidates>[0], runnable: (file: string, platform: string) => boolean = isRunnable): string | null {
  return ghCandidates(env).find((file) => runnable(file, env.platform)) ?? null
}

/** What the monitor needs: whether pressing the link can star at all, and the pressing. */
export type StarSource = { available(): boolean; star(): Promise<boolean> }

/**
 * Stars this plugin's repository with the person's own `gh`. `star()` resolves true only when
 * GitHub accepted it (`gh` exits 0); anything else (not signed in, no network, refused) is false.
 * `gh` is never left to ask a question, and one press starts one call at most.
 */
export function createStar(
  options: {
    platform?: string
    env?: NodeJS.ProcessEnv
    pluginFile?: string | null
    exec?: ExecFile
    runnable?: (file: string, platform: string) => boolean
    mono?: () => number
  } = {}
): StarSource {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exec = options.exec ?? starRunBounded
  const read = (name: string): string | null => {
    const key = Object.keys(env).find((k) => (platform === 'win32' ? k.toUpperCase() === name.toUpperCase() : k === name))
    return key === undefined ? null : (env[key] ?? null)
  }
  const find = (): string | null =>
    findGh({ platform, pathEnv: read('PATH'), home: read('HOME') ?? read('USERPROFILE'), programFiles: read('ProgramFiles') }, options.runnable)
  let running: Promise<boolean> | null = null
  // Asked with every snapshot: looked for again at most once a minute.
  const mono = options.mono ?? (() => performance.now())
  let known: { there: boolean; at: number } | null = null
  return {
    available: () => {
      const now = mono()
      if (!known || now - known.at >= AVAILABLE_CACHE_MS || now < known.at) known = { there: find() !== null, at: now }
      return known.there
    },
    star: () => {
      running ??= (async () => {
        const gh = find()
        if (!gh) return false
        // What `gh` needs to find its sign-in: on Windows that is under APPDATA, which a worker's
        // environment lacks (see cliProcessEnv).
        const childEnv: Record<string, string> = {}
        for (const [key, value] of Object.entries(cliProcessEnv(env, platform, options.pluginFile ?? null))) {
          if (typeof value === 'string') childEnv[key] = value
        }
        childEnv.GH_PROMPT_DISABLED = '1'
        childEnv.GH_NO_UPDATE_NOTIFIER = '1'
        childEnv.NO_COLOR = '1'
        try {
          const out = await exec(gh, STAR_ARGS, { timeout: STAR_TIMEOUT_MS, maxBuffer: STAR_MAX_BYTES, env: childEnv })
          return !out.error
        } catch {
          return false
        }
      })().finally(() => {
        running = null
      })
      return running
    }
  }
}
