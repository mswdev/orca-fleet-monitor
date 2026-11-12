# orca-fleet-monitor
Orca plugin that shows the live performance of every machine your Orca reaches (this computer and each paired Orca server) in one sidebar panel: memory, CPU load and the busiest workspaces. Works over Orca's own pairing, with no SSH and nothing to install on the remote machines.

> Status: early. The panel is a placeholder that proves the data flow; the real design comes later.

## What you get

- A **Fleet Monitor** panel in the right sidebar: one entry per machine with CPU, memory, load, round-trip time, Orca's own usage, the busiest workspaces and a 30-minute history.
- A status bar item naming the machine that most needs attention (`ok`, `busy`, `strained`, `critical`, plus how many are offline).
- Settings for the fast and slow polling intervals, the CPU and memory thresholds, the Orca CLI path, and whether this machine publishes its readings.

## Two tiers

Fleet Monitor reads each machine through the Orca CLI (`orca diagnostics memory --environment <server>`), so it works with nothing installed on the remote side:

- **Basic** (any paired Orca server): memory as Orca measures it, the 1-minute load average, Orca's own CPU and memory, and the busiest workspaces. There is no direct CPU reading at this tier, so CPU is *estimated* from load per core and labelled as such.
- **Full** (the remote also runs Fleet Monitor): its worker writes a short reading to its own plugin log every 5 seconds, which the desktop reads back with `orca plugin logs`. That adds measured CPU, per-core CPU, 5- and 15-minute load and uptime. The full tier has been tested only with synthetic data so far; it has not yet been proven against a real remote machine.

This computer is always read directly (Node's `os` module plus Orca's diagnostics).

## Cost

Each CLI call starts a short-lived process (about 0.3 s, mostly start-up). Machines are polled quickly (every 5 s by default) only while a Fleet Monitor panel is open, and slowly (every 60 s) otherwise. On the full tier, memory and workspaces are read every 15 s rather than every 5 s.

## Access it asks for

It is a full-access (`trusted-worker`) plugin: its worker runs as a Node process on your machine and runs the Orca CLI. It asks for one capability, `settings:own`, and adds one panel and one status bar item.

## Development

```sh
orca plugin validate .
orca plugin test .                       # unit tests, synthetic data only
```

To type-check, run `orca plugin types .` (it writes Orca's typings to `.orca/types/`) and point
`tsc` at a copy of `@types/node` as well; the repository has no dependencies, so `tsc -p .` alone
reports the Node built-ins as missing.

`tools/poll-once.ts` reads every machine once through the real CLI, outside Orca, and prints a summary with names replaced by placeholders:

```sh
env -i PATH=/usr/bin:/bin HOME="$HOME" TMPDIR="$TMPDIR" ELECTRON_RUN_AS_NODE=1 \
  /Applications/Orca.app/Contents/MacOS/Orca tools/poll-once.ts
```

The worker (`src/`) is TypeScript that Orca loads without a build step. The panel (`panel/`) is plain HTML, CSS and JavaScript; `panel/fleet-binding.mjs` is the data layer and the rest is presentation.

## License

MIT
