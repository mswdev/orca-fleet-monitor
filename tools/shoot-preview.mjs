// Makes the plugin's listing images from the real panel fed with invented sample data, using a
// locally installed Chrome, Chromium or Edge in headless mode. Nothing is downloaded.
//
//   node tools/shoot-preview.mjs [--out media] [--chrome /path/to/chrome]
//
// Writes, into media/ (what orca-plugin.json lists):
//   icon.png               512×512, the gauge from tools/preview/icon.html
//   cover.png              1600×1000, tools/preview/cover.html
//   screenshot-light.png   2560×1600, the overview and a detail, light
//   screenshot-dark.png    2560×1600, the same, dark
//   screenshot-basic.png   2560×1600, a basic machine (install row open) and an offline one
//   screenshot-activity.png 2560×1600, this computer's and a paired Mac's Activity tab, dark
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, startPreviewServer } from './preview-server.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function findChrome() {
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  }[process.platform] ?? []
  return candidates.find((file) => existsSync(file)) ?? null
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}: ${stderr.slice(-400)}`))))
  })
}

const chrome = arg('--chrome', findChrome())
if (!chrome) {
  console.error('No Chrome, Chromium or Edge found; pass --chrome /path/to/browser.')
  process.exit(1)
}
const out = path.resolve(ROOT, arg('--out', 'media'))
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(path.join(os.tmpdir(), 'fleet-monitor-chrome-'))
const { server, url } = await startPreviewServer(0)
const shots = [
  { file: 'icon.png', page: 'icon.html', size: [512, 512], scale: 1, transparent: true },
  { file: 'cover.png', page: 'cover.html', size: [1600, 1000], scale: 1 },
  { file: 'screenshot-light.png', page: 'listing.html?theme=light', size: [1280, 800], scale: 2 },
  { file: 'screenshot-dark.png', page: 'listing.html?theme=dark', size: [1280, 800], scale: 2 },
  { file: 'screenshot-basic.png', page: 'listing.html?theme=light&scene=basic', size: [1280, 800], scale: 2 },
  { file: 'screenshot-activity.png', page: 'listing.html?theme=dark&scene=activity', size: [1280, 800], scale: 2 }
]
try {
  for (const shot of shots) {
    const file = path.join(out, shot.file)
    await run(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--window-size=${shot.size[0]},${shot.size[1]}`,
      `--force-device-scale-factor=${shot.scale}`,
      ...(shot.transparent ? ['--default-background-color=00000000'] : []),
      '--virtual-time-budget=5000',
      `--screenshot=${file}`,
      `${url}/tools/preview/${shot.page}`
    ])
    console.log(`${file}  ${Math.round(statSync(file).size / 1024)} KB`)
  }
} finally {
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
