// Makes every image README.md shows (media/readme/) from the real panel fed with invented sample
// data, using a locally installed Chrome, Chromium or Edge in headless mode. Nothing is downloaded.
// Run it again whenever the panel's look or the sample fleet changes:
//
//   node tools/preview/shoot-readme.mjs
//
// Options: [--out media/readme] [--chrome /path/to/chrome] [--ffmpeg /path/to/ffmpeg]
//          [--only stills|demo]
//
// Writes, each in a light and a dark version:
//   hero-*.png          the overview beside one machine's detail
//   level-basic-*.png   the top of a basic machine's detail, under a caption
//   level-full-*.png    the top of a full machine's detail, under a caption
//   memory-*.png        a full machine's memory section
//   install-*.png       a basic machine's install row, open
//   activity-*.png      this computer's Activity tab: its tiles and the top of its process list
//   demo-*.gif          the panel in use (needs ffmpeg; skipped with a note when there is none)
//
// The stills are the elements marked data-shot in tools/preview/readme.html. The animation is
// tools/preview/readme-demo.html, stepped one frame at a time, so the same frames come out on
// every run. Both measure what the panel drew, so a section that grows or shrinks needs no change
// here; a section that is gone stops the script with a message naming it.
//
// Needs Node 22 or later (for its built-in WebSocket). It never touches the listing images in
// media/, which are tools/shoot-preview.mjs's.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, startPreviewServer } from '../preview-server.mjs'

const STILL_SCENES = ['hero', 'levels', 'memory', 'install', 'activity']
const THEMES = ['light', 'dark']
/** The animation: a sidebar-sized panel, at one and a half device pixels a pixel to keep the file small. */
const DEMO = { width: 380, height: 676, scale: 1.5 }
/** What the README's images should stay under. Larger is reported, not refused. */
const SIZE_NOTE = { '.png': 500 * 1024, '.gif': 3 * 1024 * 1024 }

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
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}: ${stderr.slice(-600)}`))))
  })
}

/** A headless browser driven over the DevTools protocol. */
async function launchBrowser(chrome, profile) {
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const address = await new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`The browser did not start: ${text.slice(-300)}`)), 20_000)
    child.stderr.on('data', (chunk) => {
      text += chunk
      const match = text.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`The browser exited ${code}: ${text.slice(-300)}`)))
  })
  const socket = new WebSocket(address)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('Could not connect to the browser')), { once: true })
  })
  let nextId = 0
  const pending = new Map()
  const waiters = new Set()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry?.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry?.resolve(message.result)
      return
    }
    for (const waiter of [...waiters]) {
      if (waiter.method === message.method && waiter.sessionId === message.sessionId) {
        waiters.delete(waiter)
        waiter.resolve(message.params)
      }
    }
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      nextId += 1
      pending.set(nextId, { resolve, reject, method })
      socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const once = (method, sessionId) =>
    new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve }
      waiters.add(waiter)
      setTimeout(() => waiters.delete(waiter) && reject(new Error(`Timed out waiting for ${method}`)), 30_000).unref()
    })

  /** A page `width`×`height` CSS pixels at `scale`, over a transparent background. */
  async function newPage({ width, height, scale }) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const call = (method, params) => send(method, params, sessionId)
    await call('Page.enable')
    await call('Runtime.enable')
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
    await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      return result.value
    }
    return {
      call,
      evaluate,
      async goto(url) {
        const loaded = once('Page.loadEventFired', sessionId)
        await call('Page.navigate', { url })
        await loaded
      },
      /** Waits until `expression` is true. A page that reports a problem (data-error on <html>)
       *  ends the wait with that problem. */
      async waitFor(expression, what) {
        const started = Date.now()
        while (Date.now() - started < 20_000) {
          const state = await evaluate(`({ error: document.documentElement.getAttribute('data-error'), done: Boolean(${expression}) })`).catch(() => null)
          if (state?.error) throw new Error(`${what}: ${state.error}`)
          if (state?.done) return
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        throw new Error(`${what}: the page was not ready after 20 seconds`)
      },
      /** PNG bytes of `clip` ({ x, y, width, height } in CSS pixels), or of the viewport. */
      async screenshot(clip = null) {
        const { data } = await call('Page.captureScreenshot', {
          format: 'png',
          ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {})
        })
        return Buffer.from(data, 'base64')
      },
      close: () => send('Target.closeTarget', { targetId })
    }
  }

  return {
    newPage,
    async close() {
      await send('Browser.close').catch(() => child.kill())
      await new Promise((resolve) => (child.exitCode === null ? child.once('exit', resolve) : resolve()))
    }
  }
}

const chrome = arg('--chrome', findChrome())
if (!chrome) {
  console.error('No Chrome, Chromium or Edge found; pass --chrome /path/to/browser.')
  process.exit(1)
}
if (typeof WebSocket !== 'function') {
  console.error('This script needs Node 22 or later (for its built-in WebSocket).')
  process.exit(1)
}
const only = arg('--only', '')
const out = path.resolve(ROOT, arg('--out', 'media/readme'))
mkdirSync(out, { recursive: true })
const work = mkdtempSync(path.join(os.tmpdir(), 'fleet-monitor-readme-'))
const { server, url } = await startPreviewServer(0)
const browser = await launchBrowser(chrome, path.join(work, 'profile'))
const written = []
function save(file, bytes) {
  if (bytes) writeFileSync(file, bytes)
  const size = statSync(file).size
  const limit = SIZE_NOTE[path.extname(file)]
  written.push(file)
  console.log(`${path.relative(ROOT, file)}  ${Math.round(size / 1024)} KB${limit && size > limit ? `  (over the ${Math.round(limit / 1024)} KB the README aims for)` : ''}`)
}

async function shootStills() {
  for (const scene of STILL_SCENES) {
    for (const theme of THEMES) {
      const page = await browser.newPage({ width: 1200, height: 1000, scale: 2 })
      await page.goto(`${url}/tools/preview/readme.html?scene=${scene}&theme=${theme}`)
      await page.waitFor('document.documentElement.hasAttribute("data-ready")', `readme.html?scene=${scene}`)
      const shots = await page.evaluate(
        '[...document.querySelectorAll("[data-shot]")].map((node) => { const r = node.getBoundingClientRect(); return { name: node.dataset.shot, clip: { x: r.left, y: r.top, width: r.width, height: r.height } } })'
      )
      if (shots.length === 0) throw new Error(`readme.html?scene=${scene}: nothing is marked data-shot`)
      for (const shot of shots) save(path.join(out, `${shot.name}-${theme}.png`), await page.screenshot(shot.clip))
      await page.close()
    }
  }
}

/**
 * The animation. readme-demo.html draws frame `n` when asked (`demo.frame(n)`) and says where its
 * pointer is and whether it is pressed, which is replayed here as real mouse input, so the panel's
 * own hover and click handling runs. The frames go to PNG files and ffmpeg makes the GIF from them.
 */
async function shootDemo() {
  const ffmpeg = arg('--ffmpeg', 'ffmpeg')
  const hasFfmpeg = await run(ffmpeg, ['-version']).then(
    () => true,
    () => false
  )
  if (!hasFfmpeg) {
    console.log('ffmpeg was not found, so demo-*.gif were not made (install it, or pass --ffmpeg /path/to/ffmpeg).')
    return
  }
  for (const theme of THEMES) {
    const page = await browser.newPage(DEMO)
    await page.goto(`${url}/tools/preview/readme-demo.html?theme=${theme}`)
    await page.waitFor('window.demo && window.demo.ready === true', 'readme-demo.html')
    const { frames, fps } = await page.evaluate('({ frames: window.demo.frames, fps: window.demo.fps })')
    const dir = path.join(work, `demo-${theme}`)
    mkdirSync(dir)
    let down = false
    for (let n = 0; n < frames; n += 1) {
      const pointer = await page.evaluate(`window.demo.pointer(${n})`)
      await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x, y: pointer.y, button: down ? 'left' : 'none', buttons: down ? 1 : 0 })
      if (pointer.down !== down) {
        down = pointer.down
        await page.call('Input.dispatchMouseEvent', {
          type: down ? 'mousePressed' : 'mouseReleased',
          x: pointer.x,
          y: pointer.y,
          button: 'left',
          buttons: down ? 1 : 0,
          clickCount: 1
        })
      }
      await page.evaluate(`window.demo.frame(${n})`)
      writeFileSync(path.join(dir, `${String(n).padStart(4, '0')}.png`), await page.screenshot())
    }
    await page.close()
    const file = path.join(out, `demo-${theme}.gif`)
    await run(ffmpeg, [
      '-y',
      '-loglevel', 'error',
      '-framerate', String(fps),
      '-i', path.join(dir, '%04d.png'),
      '-filter_complex',
      // One palette for the whole clip and no dithering: the panel is flat colour, and dithering
      // would make every frame differ from the last.
      '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
      '-loop', '0',
      file
    ])
    save(file)
  }
}

let failed = null
try {
  if (only !== 'demo') await shootStills()
  if (only !== 'stills') await shootDemo()
} catch (error) {
  failed = error
} finally {
  await browser.close().catch(() => {})
  server.close()
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
if (failed) {
  console.error(`\nStopped: ${failed.message}`)
  process.exit(1)
}
const total = written.reduce((sum, file) => sum + statSync(file).size, 0)
console.log(`\n${written.length} files, ${(total / 1024 / 1024).toFixed(1)} MB in ${path.relative(ROOT, out)}/`)
