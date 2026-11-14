// Screenshots tools/preview/capture-frame.html for one capture: the overview, and every machine's
// detail and Activity tab, at a sidebar's width, in both themes.
//
//   node tools/preview/shoot-capture.mjs --file .orca/captures/mac.json --out /tmp/shots \
//     [--playwright /path/to/playwright-core] [--chrome /path/to/chrome] [--width 360]
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, startPreviewServer } from '../preview-server.mjs'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const file = arg('--file', '')
const out = path.resolve(arg('--out', 'shots'))
const width = Number(arg('--width', '360'))
const themes = arg('--themes', 'dark,light').split(',')
const where = arg('--playwright', process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const chrome = arg('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const { chromium } = await import(existsSync(where) ? pathToFileURL(path.join(where, 'index.mjs')).href : where)
const capture = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'))
const name = path.basename(file, '.json')
mkdirSync(out, { recursive: true })
const { server, url } = await startPreviewServer(0)
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true })
const views = [{ key: 'overview', q: '' }]
capture.snapshot.machines.forEach((m, i) => {
  views.push({ key: `m${i}-detail`, q: `&machine=${encodeURIComponent(m.id)}` })
  views.push({ key: `m${i}-activity`, q: `&machine=${encodeURIComponent(m.id)}&tab=activity` })
})
try {
  for (const theme of themes) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.on('pageerror', (error) => console.log(`page error (${theme}):`, error.message))
    page.on('console', (message) => message.type() === 'error' && console.log(`console (${theme}):`, message.text()))
    for (const view of views) {
      await page.goto(`${url}/tools/preview/capture-frame.html?file=${encodeURIComponent(file)}&theme=${theme}${view.q}`)
      await page.waitForSelector('html[data-preview-ready]', { timeout: 15_000 })
      await page.screenshot({ path: path.join(out, `${name}-${view.key}-${theme}.png`), fullPage: true, animations: 'disabled' })
    }
    await context.close()
  }
  console.log(`wrote ${views.length * themes.length} shots of ${capture.snapshot.machines.map((m, i) => `m${i}=${m.name}`).join(', ')} into ${out}`)
} finally {
  await browser.close()
  server.close()
}
