// Which `os.cpus()` entries are performance cores and which are efficiency cores.
//
// Only Apple silicon Macs report the split, through `sysctl hw.perflevel0.logicalcpu` (performance)
// and `hw.perflevel1.logicalcpu` (efficiency). Node does not say which `os.cpus()` index is which,
// so the order was measured on an Apple M2 Max (8 performance + 4 efficiency cores) under macOS
// 26: four spinning shell loops at background QoS (`taskpolicy -b`), which macOS keeps on the
// efficiency cores, drove indices 0-3 to 100 %; eight spinning loops at default QoS drove indices
// 4-11 to 100 %. So the efficiency cores come first, then the performance cores. Other Apple chips
// are assumed to follow the same kernel numbering; this has not been measured on them.
//
// Anything unexpected (another platform, an Intel Mac, a missing key, counts that do not add up to
// the core count) means no split: the panel then draws one group of cores.
import { execFile } from 'node:child_process'
import type { CoreGroup } from './model.ts'

export const SYSCTL_PATH = '/usr/sbin/sysctl'
export const SYSCTL_ARGS = ['-n', 'hw.perflevel0.logicalcpu', 'hw.perflevel1.logicalcpu'] as const
const TIMEOUT_MS = 3_000

/** The split from `sysctl -n hw.perflevel0.logicalcpu hw.perflevel1.logicalcpu`, or null. */
export function coreGroupsFrom(output: string, totalCores: number): CoreGroup[] | null {
  const values = output.trim().split(/\s+/)
  if (values.length !== 2) return null
  const [performance, efficiency] = values.map((value) => (/^\d+$/.test(value) ? Number(value) : Number.NaN)) as [
    number,
    number
  ]
  if (!(performance >= 1 && efficiency >= 1) || performance + efficiency !== totalCores) return null
  return [
    { kind: 'performance', start: efficiency, count: performance },
    { kind: 'efficiency', start: 0, count: efficiency }
  ]
}

/** True when `groups` cover `0..cores-1` exactly once each. */
export function groupsFit(groups: readonly CoreGroup[] | null | undefined, cores: number): boolean {
  if (!groups || groups.length === 0 || cores < 1) return false
  const seen = new Array<boolean>(cores).fill(false)
  for (const group of groups) {
    if (!Number.isInteger(group.start) || !Number.isInteger(group.count) || group.start < 0 || group.count < 1) return false
    for (let i = group.start; i < group.start + group.count; i += 1) {
      if (i >= cores || seen[i]) return false
      seen[i] = true
    }
  }
  return seen.every(Boolean)
}

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string) => void
) => void

const realExecFile: ExecFile = (file, args, options, callback) => {
  execFile(file, [...args], { timeout: options.timeout, encoding: 'utf8', windowsHide: true }, (error, stdout) =>
    callback(error, String(stdout ?? ''))
  )
}

/** Asks once; never throws. A failing `sysctl` (or any other platform) resolves null. */
export function readCoreGroups(platform: string, totalCores: number, run: ExecFile = realExecFile): Promise<CoreGroup[] | null> {
  if (platform !== 'darwin' || totalCores < 2) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      run(SYSCTL_PATH, SYSCTL_ARGS, { timeout: TIMEOUT_MS }, (error, stdout) => {
        resolve(error ? null : coreGroupsFrom(stdout, totalCores))
      })
    } catch {
      resolve(null)
    }
  })
}
