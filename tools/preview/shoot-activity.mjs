// Photographs every 1.2 state of the preview (activity-states.mjs) at 220, 360 and 700 px, light
// and dark, full page at 2x, named as the design's pictures are (<state>--<width>--<theme>.png),
// so the two sets can be laid side by side. Uses playwright-core with a local Chrome.
//
//   node tools/preview/shoot-activity.mjs [--out <dir>] [--playwright <path to playwright-core>]
//     [--chrome <path to Chrome>] [--only <state,state>]
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startPreviewServer } from '../preview-server.mjs'
import { STATES } from './activity-states.mjs'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

// Pictures land outside the repository unless asked: the repository is public.
const out = path.resolve(arg('--out', path.join(os.tmpdir(), 'fleet-monitor-1.2-shots')))
const where = arg('--playwright', process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const chrome = arg('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const only = arg('--only', '')
  .split(',')
  .filter(Boolean)
const { chromium } = await import(existsSync(where) ? pathToFileURL(path.join(where, 'index.mjs')).href : where)
mkdirSync(out, { recursive: true })
const { server, url } = await startPreviewServer(0)
const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true })
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [220, 360, 700]) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
      const page = await context.newPage()
      for (const state of Object.keys(STATES)) {
        if (only.length > 0 && !only.includes(state)) continue
        await page.goto(`${url}/tools/preview/activity-frame.html?state=${state}&theme=${theme}`)
        await page.waitForSelector('html[data-preview-ready]', { timeout: 10_000 })
        const file = path.join(out, `${state}--${width}--${theme}.png`)
        await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
      }
      await context.close()
    }
  }
  console.log(`Wrote the 1.2 states into ${out}`)
} finally {
  await browser.close()
  server.close()
}
