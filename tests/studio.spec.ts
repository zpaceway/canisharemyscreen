import { test, expect, chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { createServer } from 'node:net'

// Exercise real MediaRecorder, canvas composition, workers, OPFS and WebCodecs.
// Only the browser permission picker is replaced with an animated synthetic screen.
async function installScreen(page: Page, options: { audio?: boolean; camera?: boolean; deny?: boolean } = {}) {
  await page.addInitScript(({ audio, camera, deny }) => {
    const timers: number[] = []
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async (constraints: DisplayMediaStreamOptions) => {
      Object.assign(window, { __testDisplayOptions: constraints })
      if (deny) throw new DOMException('Permission denied', 'NotAllowedError')
      const canvas = document.createElement('canvas')
      canvas.width = 640; canvas.height = 360
      const ctx = canvas.getContext('2d')!
      let frame = 0
      const paint = () => {
        ctx.fillStyle = '#26434d'; ctx.fillRect(0, 0, 640, 360)
        ctx.fillStyle = '#f27e9f'; ctx.fillRect((frame++ * 5) % 600, 80, 40, 100)
        ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif'; ctx.fillText('Synthetic screen capture', 32, 40)
      }
      paint(); timers.push(window.setInterval(paint, 33))
      const stream = canvas.captureStream(30)
      if (audio) {
        const ac = new AudioContext()
        const oscillator = ac.createOscillator(); const destination = ac.createMediaStreamDestination()
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start()
        await ac.resume()
        stream.addTrack(destination.stream.getAudioTracks()[0])
      }
      Object.assign(window, { __testScreen: stream })
      return stream
    } })
    if (camera) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async (constraints: MediaStreamConstraints) => {
      const stream = new MediaStream()
      if (constraints.video) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 120
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 120, 120)
        const track = canvas.captureStream(30).getVideoTracks()[0]; stream.addTrack(track)
        timers.push(window.setInterval(() => ctx.fillRect(0, 0, 120, 120), 33))
      }
      if (constraints.audio) {
        const ac = new AudioContext(); const dest = ac.createMediaStreamDestination(); const osc = ac.createOscillator()
        osc.connect(dest); osc.start(); await ac.resume(); stream.addTrack(dest.stream.getAudioTracks()[0])
      }
      return stream
    } })
    localStorage.setItem('cms:preferences:v1', JSON.stringify({ countdown: false, camera: !!camera, systemAudio: !!audio }))
  }, options)
}
async function record(page: Page, seconds = 2.3) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  await page.waitForTimeout(seconds * 1000)
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
}
test('minimal initial layout, collapsed sections and persisted settings', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeDisabled()
  await expect(page.locator('.section-trigger[aria-expanded="false"]')).toHaveCount(4)
  await page.getByRole('button', { name: 'Capture 1080p' }).click()
  await page.getByLabel('Resolution', { exact: true }).selectOption('720')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Capture 720p' })).toBeVisible()
  await expect(page.locator('.section-trigger[aria-expanded="false"]')).toHaveCount(4)
  expect(errors).toEqual([])
})
test('restore defaults appears only for changed settings and resets them', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Restore defaults' })).not.toBeVisible()
  await page.getByRole('button', { name: 'Capture 1080p' }).click()
  await page.getByLabel('Resolution', { exact: true }).selectOption('1440')
  await expect(page.getByRole('button', { name: 'Restore defaults' })).toBeVisible()
  await page.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(page.getByRole('button', { name: 'Capture 1080p' })).toBeVisible()
  await expect(page.getByText('Settings restored to their defaults.')).toBeVisible()
  await expect(page.getByText('Settings restored to their defaults.')).not.toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Restore defaults' })).not.toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Capture 1080p' })).toBeVisible()
})
test('responsive layout keeps settings usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.getByRole('button', { name: 'Show settings' }).click()
  await expect(page.getByRole('button', { name: 'Capture 1080p' })).toBeVisible()
  await page.getByRole('button', { name: 'Hide settings' }).click()
  await expect(page.getByRole('button', { name: 'Capture 1080p' })).not.toBeVisible()
})
test('denied screen access shows a useful error and can retry', async ({ page }) => {
  await installScreen(page, { deny: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await expect(page.getByText('Permission wasn’t granted.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose a screen', exact: true })).toBeEnabled()
})
test('screen audio requests capture options and has its own working volume meter', async ({ page }) => {
  await installScreen(page, { audio: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => (window as unknown as { __testDisplayOptions: unknown }).__testDisplayOptions)).toMatchObject({
    audio: { suppressLocalAudioPlayback: false }, systemAudio: 'include', windowAudio: 'system',
  })
  await page.getByRole('button', { name: 'Audio Screen', exact: true }).click()
  const meter = page.getByLabel('Screen audio input level')
  await expect(meter.locator('.lit').first()).toBeVisible()
  await page.getByLabel('Screen audio volume', { exact: true }).fill('0')
  await expect(meter.locator('.lit')).toHaveCount(0)
  await page.getByLabel('Screen audio volume', { exact: true }).fill('100')
  await expect(meter.locator('.lit').first()).toBeVisible()
})
test('missing screen audio stays visible and explains why volume cannot fix it', async ({ page }) => {
  await installScreen(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Audio Off', exact: true }).click()
  await page.getByLabel('Screen / system audio', { exact: true }).check()
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled()
  const message = page.getByText('No screen audio track was shared.', { exact: false })
  await expect(message).toBeVisible()
  await expect(page.getByLabel('Screen audio volume', { exact: true })).toBeDisabled()
  await page.waitForTimeout(5500)
  await expect(message).toBeVisible()
  await page.getByLabel('Screen / system audio', { exact: true }).uncheck()
  await expect(message).not.toBeVisible()
  await page.getByLabel('Screen / system audio', { exact: true }).check()
  await expect(message).toBeVisible()
})
test('screen and camera playback stay connected until capture is disposed', async ({ page }) => {
  await installScreen(page, { camera: true })
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      if (!this.isConnected) return Promise.reject(new DOMException('The play() request was interrupted because the media was removed from the document.', 'AbortError'))
      return play.call(this)
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled()
  await expect(page.locator('div[aria-hidden="true"] > video')).toHaveCount(2)
  await page.getByRole('button', { name: 'Change screen', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeEnabled()
  await expect(page.locator('div[aria-hidden="true"] > video')).toHaveCount(2)
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  await expect(page.locator('div[aria-hidden="true"] > video')).toHaveCount(0)
})
test('records to disk, pauses, resumes, recovers and confirms deletion', async ({ page }) => {
  await installScreen(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByText('Recording paused', { exact: true })).toBeVisible()
  const time = await page.locator('.recording-time strong').textContent()
  await page.waitForTimeout(1100)
  expect(await page.locator('.recording-time strong').textContent()).toBe(time)
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.waitForTimeout(1000)
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!))
  expect(saved.bytes).toBeGreaterThan(1000)
  expect(saved.complete).toBe(true)
  expect(saved.seconds).toBeGreaterThan(2)
  expect(saved.seconds).toBeLessThan(4)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Saved sessions' })).toBeVisible()
  await page.locator('.recovery-item > button').first().click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  await page.getByRole('button', { name: 'Discard saved recording' }).click()
  const dialog = page.getByRole('dialog', { name: 'Discard this recording?' })
  await expect(dialog).toBeVisible()
  const box = (await dialog.boundingBox())!
  const viewport = page.viewportSize()!
  expect(Math.abs((box.x + box.width / 2) - viewport.width / 2)).toBeLessThan(4)
  expect(Math.abs((box.y + box.height / 2) - viewport.height / 2)).toBeLessThan(4)
  // Clicks inside the modal, including its padding, keep it open.
  await page.mouse.click(box.x + 8, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(dialog).toBeVisible()
  // Only the backdrop closes it.
  await page.mouse.click(14, 14)
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: 'Discard saved recording' }).click()
  await page.getByRole('button', { name: 'Discard recording', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Saved sessions' })).not.toBeVisible()
})
test('camera bubble is embedded, source size is not upscaled', async ({ page }) => {
  await installScreen(page, { camera: true })
  await record(page)
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!))
  expect([saved.width, saved.height]).toEqual([640, 360])
  const pixel = await page.evaluate(async () => {
    const video = document.querySelector('video.review-video') as HTMLVideoElement
    if (video.readyState < 2) await new Promise<void>(r => video.addEventListener('loadeddata', () => r(), { once: true }))
    await new Promise<void>(resolve => { video.addEventListener('seeked', () => resolve(), { once: true }); video.currentTime = 1 })
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    const ctx = canvas.getContext('2d')!; ctx.drawImage(video, 0, 0)
    return [...ctx.getImageData(560, 285, 1, 1).data]
  })
  expect(pixel[1]).toBeGreaterThan(180)
  expect(pixel[0]).toBeLessThan(80)
})
test('streaming compression and MP4 conversion keep all audio/video tracks', async ({ page }) => {
  await installScreen(page, { audio: true })
  await record(page)
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite resolves this browser-side module.
    const { runExport } = await import('/src/lib/export.ts')
    // @ts-expect-error Vite resolves this browser-side module.
    const { defaults } = await import('/src/lib/settings.ts')
    const saved = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!)
    const root = await navigator.storage.getDirectory()
    const webm = await root.getFileHandle('test-compressed.webm', { create: true })
    const mp4 = await root.getFileHandle('test-converted.mp4', { create: true })
    await runExport(saved, { ...defaults, compression: 'small' }, webm, () => {}).promise
    await runExport(saved, { ...defaults, format: 'mp4' }, mp4, () => {}).promise
    // Use the public reader to verify containers, tracks and duration, not just file size.
    // @ts-expect-error Vite resolves this browser-side dependency.
    const { Input, BlobSource, ALL_FORMATS } = await import('/node_modules/mediabunny/dist/modules/src/index.js')
    const inspect = async (handle: FileSystemFileHandle) => {
      const file = await handle.getFile()
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
      const tracks = await input.getTracks()
      const duration = await input.computeDuration()
      const codecs = await Promise.all(tracks.map((t: { getCodec: () => Promise<string> }) => t.getCodec()))
      input.dispose()
      return { size: file.size, duration, codecs }
    }
    return { webm: await inspect(webm), mp4: await inspect(mp4) }
  })
  expect(result.webm.codecs).toEqual(['vp8', 'opus'])
  expect(result.mp4.codecs).toEqual(['avc', 'aac'])
  expect(result.mp4.duration).toBeGreaterThan(2)
  expect(result.webm.size).toBeGreaterThan(1000)
})
test('interrupted recording is recoverable after closing the page', async ({ page, context }) => {
  await installScreen(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))
    return key ? JSON.parse(localStorage.getItem(key)!).bytes : 0
  })).toBeGreaterThan(1000)
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('/')
  await reopened.locator('.recovery-item > button').first().click()
  await expect(reopened.getByText('This session was interrupted.', { exact: false })).toBeVisible()
  await expect(reopened.getByRole('button', { name: 'Download video' })).toBeEnabled()
})
test('countdown can be canceled without recording', async ({ page }) => {
  await installScreen(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Capture 1080p' }).click()
  await page.getByLabel('3-second countdown', { exact: true }).check()
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel countdown' }).click()
  await expect(page.getByRole('button', { name: 'Start recording' })).toBeEnabled()
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('cms:recording:v1:')).length)).toBe(0)
})
test('browser ending screen sharing finalizes the recording', async ({ page }) => {
  await installScreen(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))
    return key ? JSON.parse(localStorage.getItem(key)!).bytes : 0
  })).toBeGreaterThan(1000)
  await page.evaluate(() => {
    const stream = (window as unknown as { __testScreen: MediaStream }).__testScreen
    const track = stream.getVideoTracks()[0]
    track.stop()
    // stop() itself doesn't emit ended; browser-initiated revocation does.
    track.dispatchEvent(new Event('ended'))
  })
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  // Stopping the share is a normal stop, so the saved session is complete.
  const complete = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!).complete)
  expect(complete).toBe(true)
})
test('recording remains frame-driven when the preview timer is throttled', async ({ page }) => {
  await installScreen(page, { camera: true })
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      // Reproduce a throttled compositor preview without starving the input source.
      return interval(handler, String(handler).includes('this.draw()') ? 1000 : delay, ...args)
    }) as typeof window.setInterval
  })
  await record(page, 3)
  const fps = await page.evaluate(async () => {
    // @ts-expect-error Vite browser-side import.
    const { Input, BlobSource, WEBM } = await import('/node_modules/mediabunny/dist/modules/src/index.js')
    const saved = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!)
    const root = await navigator.storage.getDirectory()
    const file = await (await (await root.getDirectoryHandle('cms-recordings')).getFileHandle(`${saved.id}.webm`)).getFile()
    const input = new Input({ source: new BlobSource(file), formats: [WEBM] })
    const track = await input.getPrimaryVideoTrack()
    const stats = await track.computePacketStats()
    input.dispose()
    return stats.averagePacketRate
  })
  expect(fps).toBeGreaterThan(20)
})
test('worker frame recording continues while another tab is active', async ({ baseURL }) => {
  test.skip(process.env.BACKGROUND_TEST !== '1', 'Requires headed Chrome with normal background-throttling policies; set BACKGROUND_TEST=1.')
  const socket = createServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => socket.close(() => resolve()))
  const launched = await chromium.launch({
    channel: 'chrome', headless: false, args: [`--remote-debugging-port=${port}`],
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  })
  // Playwright otherwise forces every page to appear focused/visible. Attach to
  // this isolated browser's default context without those overrides.
  let browser: Browser
  for (let attempt = 0; ; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true }); break }
    catch (error) { if (attempt >= 5) throw error; await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  try {
  const context = browser.contexts()[0]
  const page = await context.newPage()
  // A worker-generated source is necessary: a main-thread canvas source would
  // itself be throttled and would not represent native screen capture correctly.
  await page.addInitScript(() => {
    localStorage.setItem('cms:preferences:v1', JSON.stringify({ countdown: false }))
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => {
      const Generator = (window as unknown as { MediaStreamTrackGenerator: new (init: { kind: string }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } }).MediaStreamTrackGenerator
      const track = new Generator({ kind: 'video' })
      const code = `onmessage = ({ data }) => {
        const writer = data.output.getWriter();
        const canvas = new OffscreenCanvas(640, 360);
        const ctx = canvas.getContext('2d'); let n = 0, busy = false;
        setInterval(async () => {
          if (busy) return; busy = true;
          try {
            ctx.fillStyle = '#26434d'; ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = '#ed7899'; ctx.fillRect((n++ * 5) % 600, 80, 40, 100);
            const frame = new VideoFrame(canvas, { timestamp: performance.now() * 1000 });
            try { await writer.write(frame); } finally { frame.close(); }
          } finally { busy = false; }
        }, 33);
      };`
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      const worker = new Worker(url); URL.revokeObjectURL(url)
      worker.postMessage({ output: track.writable }, [track.writable])
      return new MediaStream([track])
    } })
  })
  await page.goto(baseURL!)
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  await page.waitForTimeout(1000)
  const other = await context.newPage()
  await other.goto('about:blank'); await other.bringToFront()
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden')
  await page.waitForTimeout(4000)
  await page.bringToFront()
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  const fps = await page.evaluate(async () => {
    // @ts-expect-error Vite browser-side import.
    const { Input, BlobSource, WEBM } = await import('/node_modules/mediabunny/dist/modules/src/index.js')
    const saved = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!)
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('cms-recordings')
    const file = await (await dir.getFileHandle(`${saved.id}.webm`)).getFile()
    const input = new Input({ source: new BlobSource(file), formats: [WEBM] })
    const track = await input.getPrimaryVideoTrack()
    const { averagePacketRate } = await track.computePacketStats()
    input.dispose(); return averagePacketRate
  })
    expect(fps).toBeGreaterThan(20)
    await other.close()
  } finally { await browser.close(); await launched.close().catch(() => {}) }
})
test('disk failure stops recording and retains the committed prefix', async ({ page }) => {
  await installScreen(page)
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      private writes = 0
      private storage: boolean
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); this.storage = String(url).includes('storage.worker')
      }
      postMessage(message: { action: string; request: number }, transfer: Transferable[] = []) {
        if (this.storage && message.action === 'append' && ++this.writes > 1) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { request: message.request, error: 'Simulated disk full.' } })))
        } else super.postMessage(message, transfer)
      }
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  await expect(page.getByText('Simulated disk full.', { exact: false })).toBeVisible()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!))
  expect(saved.bytes).toBeGreaterThan(1000)
  expect(saved.complete).toBe(false)
})
test('oversized chunks stop capture without appending a broken tail', async ({ page }) => {
  await installScreen(page)
  await page.goto('/')
  await page.evaluate(() => {
    const start = MediaRecorder.prototype.start
    MediaRecorder.prototype.start = function (timeslice?: number) {
      start.call(this, timeslice)
      setTimeout(() => this.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob([new Uint8Array(33 * 1024 * 1024)]) })), 2300)
    }
  })
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  await expect(page.getByText('oversized chunk', { exact: false })).toBeVisible()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!))
  expect(saved.complete).toBe(false)
  expect(saved.bytes).toBeGreaterThan(1000)
  expect(saved.bytes).toBeLessThan(1024 * 1024)
})
test('canceling export keeps the original and does not overwrite a destination', async ({ page }) => {
  await installScreen(page)
  await record(page)
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite browser-side import.
    const { runExport } = await import('/src/lib/export.ts')
    // @ts-expect-error Vite browser-side import.
    const { defaults } = await import('/src/lib/settings.ts')
    const saved = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!)
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle('cancel-target.webm', { create: true })
    const writable = await handle.createWritable(); await writable.write('KEEP'); await writable.close()
    const job = runExport(saved, { ...defaults, compression: 'small' }, handle, () => {})
    job.cancel()
    let error = ''
    try { await job.promise } catch (e) { error = String(e) }
    const original = await (await root.getDirectoryHandle('cms-recordings')).getFileHandle(`${saved.id}.webm`)
    return { error, destination: await (await handle.getFile()).text(), originalSize: (await original.getFile()).size }
  })
  expect(result.error).toContain('canceled')
  expect(result.destination).toBe('KEEP')
  expect(result.originalSize).toBeGreaterThan(1000)
})
test('download button honors the selected MP4 compression settings', async ({ page }) => {
  await installScreen(page)
  await record(page)
  await page.evaluate(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: async () => {
      const root = await navigator.storage.getDirectory()
      return root.getFileHandle('ui-export.mp4', { create: true })
    } })
  })
  await page.getByRole('button', { name: 'Export WEBM' }).click()
  await page.getByLabel('Video format', { exact: true }).selectOption('mp4')
  await page.getByLabel('Compression', { exact: true }).selectOption('small')
  await page.getByRole('button', { name: 'Download video' }).click()
  await expect(page.getByText('Recording saved.', { exact: false })).toBeVisible()
  const header = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const file = await (await root.getFileHandle('ui-export.mp4')).getFile()
    return await file.slice(4, 8).text()
  })
  expect(header).toBe('ftyp')
})
test('optional long-session disk and heap soak', async ({ page, context }) => {
  const duration = Number(process.env.SOAK_SECONDS || 0)
  test.skip(!duration, 'Set SOAK_SECONDS to run the longer capture check.')
  test.setTimeout((duration + 30) * 1000)
  await installScreen(page, { audio: true, camera: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Choose a screen', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible()
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  await page.waitForTimeout(3000)
  await cdp.send('HeapProfiler.collectGarbage')
  const before = await cdp.send('Performance.getMetrics')
  await page.waitForTimeout(Math.max(0, duration - 3) * 1000)
  await cdp.send('HeapProfiler.collectGarbage')
  const after = await cdp.send('Performance.getMetrics')
  const heap = (m: typeof before) => m.metrics.find(metric => metric.name === 'JSHeapUsedSize')!.value
  expect(heap(after) - heap(before)).toBeLessThan(24 * 1024 * 1024)
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download video' })).toBeEnabled()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('cms:recording:v1:'))!)!))
  expect(saved.seconds).toBeGreaterThan(duration - 2)
  expect(saved.complete).toBe(true)
})
