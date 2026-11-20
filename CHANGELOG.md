# Changelog

Each release's notes. Releases before 1.4.0 have theirs on the [releases page](https://github.com/mswdev/orca-fleet-monitor/releases).

## 1.4.0

Charts that show what health was doing, a panel that moves smoothly, every disk by name, and which version each machine runs.

### Charts

- Each part of a CPU or memory line is drawn in the colour of the level it was at, so a machine that was strained ten minutes ago and is fine now shows both.
- Faint bands mark the thresholds health is judged on. CPU uses the CPU thresholds. RAM in use on a Mac has one band, at the **RAM used busy at** setting, because its strained and critical come from memory pressure, which that chart does not plot. Memory pressure and other machines' memory use the memory thresholds. A CPU estimate from the load average stays one colour with no bands, because it is never judged.
- A soft band behind the line shows each minute's lowest and highest reading, and the window's peak is marked where it happened.
- Point at a chart, or tab to it and use the arrow keys, to read any minute: how long ago, its average, its level and its range. Screen readers hear the same.
- Lines are smoothed without ever rising above a reading, a dot marks the newest reading, and detail charts are taller.
- A reading at an OK level is drawn in the same green as an OK machine's dot. Orca's theme accent is its text colour, so before this a healthy machine's charts, bars and dots were plain white in a dark theme and black in a light one. On a tinted theme where the green would be hard to see, the panel picks a colour that stands out.

### Colours

- Four new settings, **OK colour**, **Busy colour**, **Strained colour** and **Critical colour**, let you pick your own colour for each level, for example if you are colour-blind and cannot tell the green from the orange or red. Type a hex code such as `#0072b2` or a colour name such as `blue`. The panel changes as soon as you do, in light and dark themes alike, and leave one empty to keep Fleet Monitor's own.

### Motion

- Charts glide to each new reading, and a detail chart rises from its baseline when it opens. Minutes are counted on the clock, so the chart scrolls as time passes instead of redrawing.
- Figures count up or down to their new values, per-core bars and meters grow and shrink, and level colours fade into each other.
- Workspace and process rows that change place slide there, on lists of up to 60 rows.
- Opening a machine, going back and switching between Overview and Activity slide the screen.
- With the system's reduce motion setting on, nothing moves. Between readings no animation runs.

### Disks

- The Activity tab shows how full each local disk is, by name, up to eight. On a Mac these are the startup disk and the other volumes Finder shows that can be written to; APFS volumes that share one disk's space are one row. On Linux they are the filesystems on the machine's own disks and its ZFS pools (each pool's space as `zfs list` gives it), without boot partitions, snaps or container storage. On Windows they are the fixed drives, named as Explorer names them, such as `Data (D:)`, and fixed volumes mounted in a folder. Network shares are never included.
- With one disk, the tile names it. With several, a wide **Disks** tile has a row for each, coloured busy from 90% full and strained from 95%. Read and write speed stays the total over every disk.

### Versions

- The foot of the overview shows this computer's version of Fleet Monitor, with **Star on GitHub** moved to the left.
- A machine's detail lists the version it runs under **System**.
- When a machine runs an older version than another, its card has a red **Outdated Version** tag, and its detail opens with a red notice naming the newer version and where it runs, and how to update it there: a Copy button for the exact `orca plugin update` command when the panel can tell how it was installed, or where to find it in settings when it cannot. This computer can be the one behind too.
- Fleet Monitor 1.4 publishes its version. A paired machine on an older version shows as older than 1.4.0. One whose version cannot be told is never called out of date.

### The overview

- Each card shows how long ago its newest reading came, counting up every second, so you can see machines updating without opening them.
- Tags such as **This Mac** sit before the machine's name, so the ticking time never moves them.
- The memory pressure word wraps in a narrow panel instead of pushing it sideways.

### Updating

Update each machine from **Settings → Plugins** in Orca on that machine. From a terminal on it, a copy installed from the catalog updates with `orca plugin update mswdev.fleet-monitor --environment local` (`orca-ide` instead of `orca` on Linux); approve when it asks. Once this computer runs 1.4.0, a machine that is behind shows the exact command for it. Disk names and versions need 1.4.0 both on the machine and on the computer showing it.

824 tests.
