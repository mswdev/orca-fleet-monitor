// One resident Windows PowerShell, asked for readings over its standard input and output.
//
// Windows ships no small command-line tools for a network adapter's byte counters, disk traffic,
// GPU utilisation, the battery or a process list with memory figures. What it has is .NET, and
// the way to it that every Windows has is powershell.exe (Windows PowerShell 5.1), which costs a
// few hundred ms of CPU each time it starts. So one is started with the first request and kept:
//
//   Node writes one line          <id> <command>
//   PowerShell answers with one   <id> <compact JSON>      (`<id> null` when the read failed)
//
// It does nothing between requests: there is no timer in the script, and every cadence, age and
// rate is worked out in TypeScript (src/win-system.ts, src/win-processes.ts), where it is tested.
// The script ends when its standard input closes, which is what happens when the worker dies, so
// it is never left behind. The commands:
//
//   net    the adapter that is up, is neither loopback nor a tunnel, and has a default gateway
//          (the first with an IPv4 one): its name and cumulative bytes received and sent
//          (System.Net.NetworkInformation)
//   disk   cumulative bytes read and written over every physical disk: the raw values of the
//          PhysicalDisk counters "Disk Read Bytes/sec" and "Disk Write Bytes/sec", instance _Total
//   gpu    the busiest GPU's utilisation between this request and the one before, from the
//          "GPU Engine" counters (Windows 10 1709 and later); null on the first request. A GPU
//          has several engines (3D, copy, video decode, ...), each with one counter per process
//          using it: an engine's figure is the sum over its processes, and the GPU's is its
//          busiest engine, which is the one figure Task Manager shows for a GPU. A computer
//          whose only display adapters are software ones (a virtual machine or a server
//          without a GPU: Microsoft's basic display adapter, Hyper-V's video) gets no figure,
//          though those too have engine counters. They are told by their device id (ROOT\,
//          VMBUS\, SWD\, or PCI vendor 1414, Microsoft), since Windows translates their names;
//          that is asked of WMI once, with a time limit
//   bat    the power line, the battery's charge and flags, and the seconds it has left
//          (System.Windows.Forms.SystemInformation.PowerStatus)
//   proc   every process from one read of the "Process" counters: pid, parent pid, name,
//          cumulative CPU time, private working set and start time
//
// .NET keeps what it learns of the counters for the life of the process, a missing or broken
// category included. So when a request fails, the script lets go of that (CloseSharedResources,
// once a minute at most) and the next request looks afresh: counters repaired meanwhile (`lodctr
// /R`) are found without restarting anything.
//
// .NET takes the counters' English names on every display language. Nothing here needs
// elevation, and no path, command line or window title is read at all: a process's name is its
// counter instance name, which is the image's file name without `.exe`.
//
// Cost, measured on a 4-core CI machine with about 150 processes (tools/smoke-system.ts): the
// first answer comes about 4.5 s after the first request, PowerShell's start and its first use of
// the counters included; each later request is answered in 10 to 20 ms; the process holds about
// 65 MB and used under 1% of one core, asked every 7 s. Not measured on a desktop with several
// hundred processes, nor with a real GPU.
import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import type { Timers } from './processes.ts'

/** What the script answers to; anything else is answered `null`. */
export const HOST_COMMANDS = ['net', 'disk', 'gpu', 'bat', 'proc'] as const

/**
 * The script, as powershell.exe is given it after `-Command`. Three things it must never hold:
 *   a double quote    Windows passes arguments as one command line, and a quote in one has to be
 *                     escaped in a way two parsers must agree on; with none, the text arrives as
 *                     it is written here (the script makes the quote JSON needs from its number)
 *   `$input`          PowerShell reads all of standard input itself, to the end, for a command
 *                     that mentions it, and the loop below would never see a line
 *   a backtick        PowerShell's escape character, and the end of this template
 * Written for Windows PowerShell 5.1. The counter names indexed out of a category read are in
 * lower case because that is how .NET keys them, whichever way PowerShell looks them up; and a
 * category's instances are walked with GetEnumerator, never `.Values`, which PowerShell may read
 * as the entry of that name (a process called `values`, say).
 */
export const HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8 } catch { }
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.NewLine = [string][char]10
$q = [string][char]34
$bad = [regex]'[\x00-\x1f]'
$global:fmDisk = $null
$global:fmGpu = $null
$global:fmHasGpu = $null
$global:fmReset = [DateTime]::MinValue
$global:fmForms = $false

function FmJson($value) {
  ConvertTo-Json -InputObject $value -Compress -Depth 4
}

function FmNet {
  $pick = $null
  $spare = $null
  foreach ($i in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($i.OperationalStatus -ne 'Up') { continue }
    $kind = $i.NetworkInterfaceType
    if ($kind -eq 'Loopback' -or $kind -eq 'Tunnel') { continue }
    $gates = $null
    try { $gates = $i.GetIPProperties().GatewayAddresses } catch { continue }
    foreach ($g in $gates) {
      $a = $g.Address
      if ($null -eq $a -or $a.Equals([System.Net.IPAddress]::Any) -or $a.Equals([System.Net.IPAddress]::IPv6Any)) { continue }
      if ($a.AddressFamily -eq 'InterNetwork') { $pick = $i; break }
      if ($null -eq $spare) { $spare = $i }
    }
    if ($null -ne $pick) { break }
  }
  if ($null -eq $pick) { $pick = $spare }
  if ($null -eq $pick) { return $null }
  $s = $pick.GetIPStatistics()
  FmJson @{ n = $pick.Name; rx = $s.BytesReceived; tx = $s.BytesSent }
}

function FmDisk {
  if ($null -eq $global:fmDisk) {
    $r = New-Object System.Diagnostics.PerformanceCounter('PhysicalDisk', 'Disk Read Bytes/sec', '_Total')
    $w = New-Object System.Diagnostics.PerformanceCounter('PhysicalDisk', 'Disk Write Bytes/sec', '_Total')
    $global:fmDisk = @($r, $w)
  }
  try {
    FmJson @{ r = $global:fmDisk[0].RawValue; w = $global:fmDisk[1].RawValue }
  } catch {
    $global:fmDisk = $null
    throw
  }
}

function FmGpu {
  if ($null -eq $global:fmHasGpu) {
    $global:fmHasGpu = $true
    try {
      $real = @(Get-CimInstance -ClassName Win32_VideoController -Property PNPDeviceID -OperationTimeoutSec 5 | Where-Object { $_.PNPDeviceID -and $_.PNPDeviceID -notmatch '^(ROOT|VMBUS|SWD)\\|^PCI\\VEN_1414' })
      $global:fmHasGpu = ($real.Count -gt 0)
    } catch { }
  }
  if (-not $global:fmHasGpu) { return $null }
  if (-not [System.Diagnostics.PerformanceCounterCategory]::Exists('GPU Engine')) { return $null }
  $now = (New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')).ReadCategory()['utilization percentage']
  if ($null -eq $now) { return $null }
  $old = $global:fmGpu
  $keep = @{}
  $sums = @{}
  $seen = 0
  foreach ($e in $now.GetEnumerator()) {
    $d = $e.Value
    $n = $d.InstanceName
    $s = $d.Sample
    $keep[$n] = $s
    if ($null -eq $old -or -not $old.ContainsKey($n)) { continue }
    if ($n -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_') {
      $k = $Matches[1] + ' ' + $Matches[2] + ' ' + $Matches[3]
      $v = 0
      try { $v = [System.Diagnostics.CounterSampleCalculator]::ComputeCounterValue($old[$n], $s) } catch { $v = 0 }
      $sums[$k] = [double]$sums[$k] + $v
      $seen = $seen + 1
    }
  }
  $global:fmGpu = $keep
  if ($null -eq $old -or $seen -eq 0) { return $null }
  $best = [double]0
  foreach ($e in $sums.GetEnumerator()) {
    if ($e.Value -gt $best) { $best = $e.Value }
  }
  if ($best -gt 100) { $best = [double]100 }
  FmJson @{ p = $best }
}

function FmBat {
  if (-not $global:fmForms) {
    Add-Type -AssemblyName System.Windows.Forms
    $global:fmForms = $true
  }
  $p = [System.Windows.Forms.SystemInformation]::PowerStatus
  FmJson @{ line = [int]$p.PowerLineStatus; flag = [int]$p.BatteryChargeStatus; pct = [int][Math]::Round(100 * $p.BatteryLifePercent); secs = [int]$p.BatteryLifeRemaining }
}

function FmProc {
  $data = (New-Object System.Diagnostics.PerformanceCounterCategory('Process')).ReadCategory()
  $par = $data['creating process id']
  $cpu = $data['% processor time']
  $mem = $data['working set - private']
  $age = $data['elapsed time']
  $t = 0
  $rows = New-Object System.Collections.Generic.List[string]
  foreach ($e in $data['id process'].GetEnumerator()) {
    $k = $e.Key
    $d = $e.Value
    $n = $d.InstanceName
    $t = $d.Sample.TimeStamp100nSec
    if ($n -eq '_Total' -or $n -eq 'Idle') { continue }
    $rows.Add('[' + $d.RawValue + ',' + $par[$k].RawValue + ',' + $q + $bad.Replace($n, ' ').Replace('\', '\\').Replace($q, '\' + $q) + $q + ',' + $cpu[$k].RawValue + ',' + $mem[$k].RawValue + ',' + $age[$k].RawValue + ']')
  }
  '{' + $q + 't' + $q + ':' + $t + ',' + $q + 'p' + $q + ':[' + ($rows -join ',') + ']}'
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $at = $line.IndexOf(' ')
  if ($at -lt 1) { continue }
  $id = $line.Substring(0, $at)
  $r = $null
  try {
    $ErrorActionPreference = 'Stop'
    switch ($line.Substring($at + 1)) {
      'net' { $r = FmNet }
      'disk' { $r = FmDisk }
      'gpu' { $r = FmGpu }
      'bat' { $r = FmBat }
      'proc' { $r = FmProc }
    }
  } catch {
    $r = $null
    if (([DateTime]::UtcNow - $global:fmReset).TotalSeconds -ge 60) {
      $global:fmReset = [DateTime]::UtcNow
      $global:fmDisk = $null
      $global:fmGpu = $null
      try { [System.Diagnostics.PerformanceCounter]::CloseSharedResources() } catch { }
    }
  }
  if ($r -isnot [string] -or $r.Length -eq 0) { $r = 'null' }
  $out.WriteLine($id + ' ' + $r)
  $out.Flush()
}
`.trim()

/** Before the script: no banner, no profile (a person's own could print or take seconds), no
 *  prompt ever, and `-Command` with the script as plain text. Never `-EncodedCommand`, which
 *  security tools take for something hiding. */
export const HOST_FLAGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] as const

const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'

/** A Windows variable, whatever case its name is in: Windows ignores the case, but an
 *  environment copied into a plain object does not. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : env[key]
}

/** The Windows folder: `SystemRoot`, else `windir`, when it is a plain path on a lettered drive;
 *  `C:\Windows` otherwise. */
export function systemRoot(env: NodeJS.ProcessEnv): string {
  for (const name of ['SystemRoot', 'windir']) {
    const value = readEnv(env, name)
    if (value !== undefined && /^[A-Za-z]:\\[^/:*?"<>|\u0000-\u001f]*$/.test(value) && value.length <= 200) return value
  }
  return DEFAULT_SYSTEM_ROOT
}

/** Windows PowerShell by its full path, so that nothing on PATH can stand in for it. */
export function powershellPath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** What PowerShellHost needs of a child process (a test seam). */
export type HostChild = {
  pid?: number | undefined
  stdin: { write(text: string): unknown; on(event: 'error', listener: (error: Error) => void): unknown } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type SpawnHost = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => HostChild

const realSpawnHost: SpawnHost = (file, args, env) =>
  nodeSpawn(file, [...args], { stdio: ['pipe', 'pipe', 'ignore'], env, shell: false, windowsHide: true }) as unknown as HostChild

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** A new process's first answer may take this much longer than the request's own timeout:
 *  PowerShell has to start first (an estimate: well under a second as a rule, several on a
 *  computer that is busy, as one often is just after signing in). */
export const HOST_START_MS = 10_000
/** After a process that ended, stalled or could not be started, the next one waits: 5 s, then
 *  twice as long each time up to 5 minutes, and 5 s again only after a process that lasted
 *  5 minutes. */
export const HOST_RESTART_MIN_MS = 5_000
export const HOST_RESTART_MAX_MS = 5 * 60_000
/** After this many processes in a row that never answered anything, PowerShell is taken to be
 *  unusable here (blocked by policy, or in Constrained Language Mode, where the script cannot
 *  run): it is tried again only every HOST_GIVE_UP_MS, and `unavailable` says so meanwhile. */
export const HOST_GIVE_UP_STARTS = 5
export const HOST_GIVE_UP_MS = 60 * 60_000
/** A command that runs out of time this many times in a row is answered null, unasked, for
 *  HOST_GIVE_UP_MS: each time it stalls, PowerShell is killed and every other reading waits. */
export const HOST_STALL_LIMIT = 3
/** Longest answer line, in characters. A process list is about 80 bytes a process. */
export const HOST_LINE_MAX = 4 * 1024 * 1024
/** Requests that may wait at once; each reader asks for one thing at a time, so a handful do. */
export const HOST_QUEUE_MAX = 32
/** No request may wait longer than this, whatever it asks for. */
const TIMEOUT_MAX_MS = 10 * 60_000
/** A command is one plain word, so a request can never carry a second line. */
const COMMAND = /^[a-z]{1,16}$/

/** What a request came to: `answered` only when PowerShell itself sent this request's line
 *  (its value may still be null: the handler failed). Not answered: nothing was asked (stopped,
 *  pausing, a command left alone) or the process went before it answered. */
export type HostAnswer = { answered: boolean; value: unknown }
const UNASKED: HostAnswer = Object.freeze({ answered: false, value: null })

type Waiting = { command: string; timeoutMs: number; resolve: (answer: HostAnswer) => void }

/**
 * One resident powershell.exe running HOST_SCRIPT, started with the first request. Requests are
 * answered one at a time, in order. The process is killed when an answer does not come in time or
 * a line runs past HOST_LINE_MAX, and on `stop()`; whenever it goes, by itself or not, everything
 * waiting is answered null, and requests are answered null without starting anything until a
 * growing pause is over. `request` never rejects and never throws. On any other platform nothing
 * is started and every answer is null.
 */
export class PowerShellHost {
  private readonly spawnHost: SpawnHost
  private readonly timers: Timers
  private readonly platform: string
  private readonly file: string
  private readonly env: NodeJS.ProcessEnv
  private child: HostChild | null = null
  private decoder = new StringDecoder('utf8')
  private buffer = ''
  /** Whether this process has answered anything: until it has, it may still be starting. */
  private answered = false
  private active: (Waiting & { id: number; timer: unknown }) | null = null
  private queue: Waiting[] = []
  /** Ids go on across processes, so an answer from one is never taken for another's. */
  private nextId = 1
  private pause: unknown = null
  private restartDelay = HOST_RESTART_MIN_MS
  /** When the running process was started, and how many in a row have ended without answering. */
  private startedAt = 0
  private barren = 0
  /** How many times in a row each command has run out of time, and which are left alone until when. */
  private readonly stalls = new Map<string, number>()
  private readonly refusedUntil = new Map<string, number>()
  private stopped = false
  private readonly mono: () => number

  constructor(deps: { spawn?: SpawnHost; timers?: Timers; platform?: string; env?: NodeJS.ProcessEnv; mono?: () => number } = {}) {
    this.mono = deps.mono ?? (() => performance.now())
    this.spawnHost = deps.spawn ?? realSpawnHost
    this.timers = deps.timers ?? realTimers
    this.platform = deps.platform ?? process.platform
    const env = deps.env ?? process.env
    this.file = powershellPath(env)
    // Orca starts a worker with a short list of variables. Windows programs look for their own
    // files through SystemRoot, so PowerShell is given it should the list ever lack it.
    this.env = readEnv(env, 'SystemRoot') === undefined ? { ...env, SystemRoot: systemRoot(env) } : env
  }

  /** Whether a PowerShell process is running now. */
  get running(): boolean {
    return this.child !== null
  }

  /**
   * Asks for one reading: the parsed JSON of the answer, or null when there is none (the read
   * failed, PowerShell did not answer within `timeoutMs` of being asked, it ended, or it is not
   * running and may not be started yet). The time a request waits for the ones before it does not
   * count towards `timeoutMs`.
   */
  request(command: string, timeoutMs: number): Promise<unknown | null> {
    return this.ask(command, timeoutMs).then((answer) => answer.value)
  }

  /** `request`, saying as well whether PowerShell answered at all: a caller that counts failures
   *  must not count the times nothing was asked. */
  ask(command: string, timeoutMs: number): Promise<HostAnswer> {
    if (this.platform !== 'win32' || this.stopped || this.pause !== null || this.queue.length >= HOST_QUEUE_MAX) return Promise.resolve(UNASKED)
    if (typeof command !== 'string' || !COMMAND.test(command) || !(timeoutMs > 0)) return Promise.resolve(UNASKED)
    const refused = this.refusedUntil.get(command)
    if (refused !== undefined) {
      if (this.mono() < refused) return Promise.resolve(UNASKED)
      // Its hour is up: one more try, and one more stall puts it back.
      this.refusedUntil.delete(command)
      this.stalls.set(command, HOST_STALL_LIMIT - 1)
    }
    return new Promise((resolve) => {
      this.queue.push({ command, timeoutMs: Math.min(timeoutMs, TIMEOUT_MAX_MS), resolve })
      this.send()
    })
  }

  /** True while PowerShell looks unusable on this computer: HOST_GIVE_UP_STARTS processes in a
   *  row ended without answering anything. It is still tried again, once an hour. */
  get unavailable(): boolean {
    return this.barren >= HOST_GIVE_UP_STARTS
  }

  /** Kills the process and answers everything waiting with null. For good: a request made after
   *  this is answered null and starts nothing, so a late one cannot leave a PowerShell running. */
  stop(): void {
    this.stopped = true
    this.timers.clearTimeout(this.pause)
    this.pause = null
    this.kill()
    this.release()
  }

  /** Writes the next waiting request, starting PowerShell first when none runs. */
  private send(): void {
    if (this.active || this.queue.length === 0) return
    if (!this.child && !this.start()) {
      // Nothing started at all: as barren as a process that never answered.
      this.answered = false
      this.failed()
      return
    }
    const child = this.child
    const next = this.queue.shift()
    if (!child || !next) return
    const id = this.nextId++
    const timer = this.timers.setTimeout(
      () => {
        if (this.active?.id !== id) return
        // The same command, too slow again and again (a counter provider or WMI that hangs):
        // asking it only costs every other reading its PowerShell, so it is left alone a while.
        // Only on a PowerShell that has answered something: before that it may just be starting.
        if (this.answered) {
          const stalls = (this.stalls.get(next.command) ?? 0) + 1
          this.stalls.set(next.command, stalls)
          if (stalls >= HOST_STALL_LIMIT) this.refusedUntil.set(next.command, this.mono() + HOST_GIVE_UP_MS)
        }
        this.failed(true)
      },
      next.timeoutMs + (this.answered ? 0 : HOST_START_MS)
    )
    this.active = { ...next, id, timer }
    try {
      child.stdin?.write(`${id} ${next.command}\n`)
    } catch {
      this.failed()
    }
  }

  private start(): boolean {
    let child: HostChild
    try {
      child = this.spawnHost(this.file, [...HOST_FLAGS, HOST_SCRIPT], this.env)
    } catch {
      return false
    }
    const ended = (): void => {
      if (this.child === child) this.failed()
    }
    // A program that cannot be started says so in an `error` event, which must be listened for.
    child.on('error', ended)
    child.on('exit', ended)
    if (!child.stdin || !child.stdout) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Never started.
      }
      return false
    }
    // Writing to a process that has gone fails in an event of the pipe's own.
    child.stdin.on('error', ended)
    child.stdout.on('data', (chunk) => this.take(child, chunk))
    this.child = child
    this.decoder = new StringDecoder('utf8')
    this.buffer = ''
    this.answered = false
    this.startedAt = this.mono()
    return true
  }

  /** Output arrives in pieces that need not end where a line, or even a character, does. */
  private take(child: HostChild, chunk: Buffer | string): void {
    if (this.child !== child) return
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end === -1) break
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (line.length > HOST_LINE_MAX) {
        this.failed()
        return
      }
      this.answer(line)
      if (this.child !== child) return
    }
    if (this.buffer.length > HOST_LINE_MAX) this.failed()
  }

  private answer(line: string): void {
    const active = this.active
    const text = line.replace(/^\uFEFF/, '').replace(/\r$/, '')
    const space = text.indexOf(' ')
    // Any line but the answer waited for is dropped: one for a request already given up on, or
    // something PowerShell printed by itself.
    if (!active || space < 1 || text.slice(0, space) !== String(active.id)) return
    this.timers.clearTimeout(active.timer)
    this.active = null
    this.answered = true
    this.barren = 0
    this.stalls.delete(active.command)
    let value: unknown = null
    try {
      value = JSON.parse(text.slice(space + 1))
    } catch {
      // Not JSON: no reading, but the process answered, so it stays.
      value = null
    }
    active.resolve({ answered: true, value })
    this.send()
  }

  /** This process is of no more use (it ended, stalled, or wrote a line too long), or none could
   *  be started: it is killed, everything waiting is answered null, and the pause begins. */
  private failed(timedOut = false): void {
    // The pause grows with each failure and starts over only after a process that lasted: one
    // answer does not count, or a PowerShell that answers `net` and then stalls on a counter
    // would be started again every few seconds for good.
    const lasted = this.child !== null && this.mono() - this.startedAt >= HOST_RESTART_MAX_MS
    // A process that was only slow (a disk busy after sign-in) is not one that cannot run: only
    // one that ended, or never started, without a word counts towards giving up.
    if (!this.answered && !timedOut) this.barren += 1
    this.kill()
    this.release()
    if (this.stopped || this.pause !== null) return
    if (lasted) this.restartDelay = HOST_RESTART_MIN_MS
    const delay = this.barren >= HOST_GIVE_UP_STARTS ? HOST_GIVE_UP_MS : this.restartDelay
    this.restartDelay = Math.min(HOST_RESTART_MAX_MS, this.restartDelay * 2)
    this.pause = this.timers.setTimeout(() => {
      this.pause = null
    }, delay)
  }

  private release(): void {
    const waiting: Waiting[] = this.active ? [this.active, ...this.queue] : this.queue
    if (this.active) this.timers.clearTimeout(this.active.timer)
    this.active = null
    this.queue = []
    for (const w of waiting) w.resolve(UNASKED)
  }

  private kill(): void {
    const child = this.child
    this.child = null
    this.buffer = ''
    if (!child) return
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}
