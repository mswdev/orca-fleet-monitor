// Saves listing screenshots (1280×800, light and dark) of the panel with invented sample data,
// using a locally installed Chrome or Chromium in headless mode. Nothing is downloaded.
//
//   node tools/shoot-preview.mjs [--out .orca/shots] [--chrome /path/to/chrome]
//
// Writes fleet-monitor-light.png and fleet-monitor-dark.png. .orca/ is ignored by Git and by
// Orca, so nothing lands in the plugin by accident; copy the ones you want.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
const out = path.resolve(ROOT, arg('--out', '.orca/shots'))
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(path.join(os.tmpdir(), 'fleet-monitor-chrome-'))
const { server, url } = await startPreviewServer(0)
try {
  for (const theme of ['light', 'dark']) {
    const file = path.join(out, `fleet-monitor-${theme}.png`)
    await run(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      '--virtual-time-budget=4000',
      `--screenshot=${file}`,
      `${url}/tools/preview/listing.html?theme=${theme}`
    ])
    console.log(file)
  }
} finally {
  server.close()
  rmSync(profile, { recursive: true, force: true })
}
