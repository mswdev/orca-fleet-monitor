// The person's own health colours: what counts as a colour, how they reach the page, and that a
// chosen colour is never swapped for another. Every value is invented.
import { assert, describe, test } from 'orca/testing'
import { applyColors, chosenColor, colorOf, colorsOf, COLOR_SETTINGS, followColors } from '../panel/colors.mjs'
import { FakeDocument } from './fake-dom.ts'

const NAMES = new Set(['blue', 'purple', 'rebeccapurple', 'teal'])
const knows = (name: string) => NAMES.has(name)
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as {
  contributes: { settings: { key: string; type: string; default: unknown }[] }
}

describe('a colour as typed', () => {
  test('a hex code, with or without #, short or long, in any case', () => {
    assert.equal(colorOf('#0072B2', knows), '#0072b2')
    assert.equal(colorOf(' 0072b2 ', knows), '#0072b2')
    assert.equal(colorOf('#07b', knows), '#0077bb')
  })

  test('a colour name CSS knows', () => {
    assert.equal(colorOf('Purple', knows), 'purple')
    assert.equal(colorOf('rebeccapurple', knows), 'rebeccapurple')
  })

  test('anything else is no colour, and never reaches the styles', () => {
    for (const value of ['', '   ', '#12345', '#ggg', 'blurple', 'inherit', 'transparent', 'currentColor', 'red; background: url(x)', 'url(https://x)', 'rgb(1, 2, 3)', 'var(--x)', 42, null, undefined, {}]) {
      assert.equal(colorOf(value, (n) => n !== 'blurple'), null, String(value))
    }
  })

  test('each level from its setting; one not set, or not a colour, keeps Fleet Monitor’s own', () => {
    assert.deepEqual(colorsOf({ colorOk: '#0072b2', colorBusy: '', colorStrained: 'nonsense', colorCritical: '000' }, knows), { ok: '#0072b2', busy: null, strained: null, critical: '#000000' })
    assert.deepEqual(colorsOf(null, knows), { ok: null, busy: null, strained: null, critical: null })
  })

  test('the manifest declares the four, as text that is empty by default', () => {
    for (const key of Object.values(COLOR_SETTINGS)) {
      const setting = manifest.contributes.settings.find((s) => s.key === key)
      assert.ok(setting, key)
      assert.deepEqual([setting.type, setting.default], ['string', ''], key)
    }
  })
})

describe('on the page', () => {
  test('each chosen colour is set on <html> over the theme, and taken off again when cleared', () => {
    const doc = new FakeDocument()
    const html = doc.documentElement
    assert.deepEqual(applyColors({ ok: '#0072b2', busy: null, strained: '#cc79a7', critical: null }, doc as never), ['ok', 'strained'])
    assert.equal(html.style.getPropertyValue('--fm-health-ok'), '#0072b2')
    assert.equal(html.style.getPropertyValue('--fm-health-strained'), '#cc79a7')
    assert.equal(html.style.getPropertyValue('--fm-health-busy'), '')
    assert.equal(chosenColor('ok', doc as never), true)
    assert.equal(chosenColor('busy', doc as never), false)
    applyColors({ ok: null, busy: null, strained: null, critical: null }, doc as never)
    assert.equal(html.style.getPropertyValue('--fm-health-ok'), '')
    assert.equal(html.getAttribute('data-fm-colors'), null)
  })

  test('only a colour is ever set, however the colours are handed over', () => {
    const doc = new FakeDocument()
    assert.deepEqual(applyColors({ ok: 'linear-gradient(red, blue)', busy: 'url(x)', strained: '#abc', critical: 'teal' }, doc as never, knows), ['strained', 'critical'])
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-ok'), '')
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-strained'), '#aabbcc')
  })

  test('changes that cannot be listened to still leave the colours read, and the panel opening', async () => {
    const doc = new FakeDocument()
    const orca = {
      settings: {
        get: async () => ({ colorOk: '#0072b2' }),
        onDidChange: () => {
          throw new Error('no events here')
        }
      }
    }
    await followColors(orca, () => {}, doc as never, knows).ready
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-ok'), '#0072b2')
  })

  test('a read still under way when it is disposed changes nothing', async () => {
    const doc = new FakeDocument()
    let release: (value: Record<string, unknown>) => void = () => {}
    const orca = { settings: { get: () => new Promise<Record<string, unknown>>((resolve) => (release = resolve)) } }
    const follow = followColors(orca, () => {}, doc as never, knows)
    follow.dispose()
    release({ colorOk: '#0072b2' })
    await follow.ready
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-ok'), '')
  })

  test('followed from Orca’s settings: now, and on each change to a colour setting', async () => {
    const doc = new FakeDocument()
    let values: Record<string, unknown> = { colorOk: 'teal', cpuBusyPercent: 70 }
    let reads = 0
    let listener: ((change: { key: string }) => void) | null = null
    let checks = 0
    const orca = {
      settings: {
        get: async () => {
          reads += 1
          return { ...values }
        },
        onDidChange: (fn: (change: { key: string }) => void) => {
          listener = fn
          return { dispose: () => (listener = null) }
        }
      }
    }
    const follow = followColors(orca, () => (checks += 1), doc as never, knows)
    await follow.ready
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-ok'), 'teal')
    assert.equal(checks, 1, 'the contrast check runs after')
    listener!({ key: 'cpuBusyPercent' })
    assert.equal(reads, 1, 'another setting changing reads nothing')
    values = { colorOk: '', colorCritical: '#d55e00' }
    listener!({ key: 'colorCritical' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-ok'), '')
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-critical'), '#d55e00')
    follow.dispose()
    assert.equal(listener, null)
  })

  test('settings that cannot be read leave the colours as they are; a frame without settings keeps its own', async () => {
    const doc = new FakeDocument()
    applyColors({ ok: '#0072b2', busy: null, strained: null, critical: null }, doc as never)
    await followColors({ settings: { get: async () => Promise.reject(new Error('gone')) } }, () => {}, doc as never, knows).ready
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-ok'), '#0072b2')
    await followColors({}, () => {}, doc as never, knows).ready
    assert.equal(doc.documentElement.style.getPropertyValue('--fm-health-ok'), '#0072b2')
  })
})
