import type { Settings } from './settings'

const scope = self as unknown as DedicatedWorkerGlobalScope
let settings: Settings
let screenReader: ReadableStreamDefaultReader<VideoFrame> | undefined
let cameraReader: ReadableStreamDefaultReader<VideoFrame> | undefined
let writer: WritableStreamDefaultWriter<VideoFrame> | undefined
let screen: VideoFrame | undefined
let face: VideoFrame | undefined
let ctx: OffscreenCanvasRenderingContext2D
let stopped = false
let writing = false
let clockOffset: number | undefined
let lastTimestamp = -Infinity

async function stop() {
  stopped = true
  screen?.close(); screen = undefined
  face?.close(); face = undefined
  await Promise.allSettled([screenReader?.cancel(), cameraReader?.cancel(), writer?.abort()])
}
function fail(error: unknown) {
  if (!stopped) scope.postMessage({ error: error instanceof Error ? error.message : String(error) })
  void stop()
}
async function render() {
  if (stopped || writing || !screen || !writer || clockOffset === undefined) return
  // Map event time onto the screen source's clock. Camera and screen sources may
  // expose different timestamp origins. No timer or document visibility is used.
  const timestamp = clockOffset + performance.now() * 1000
  if (timestamp - lastTimestamp < 1e6 / settings.fps - 1000) return
  lastTimestamp = timestamp
  writing = true
  try {
    const { width, height } = ctx.canvas
    ctx.drawImage(screen, 0, 0, width, height)
    if (settings.camera && face) {
      const size = Math.min(width * settings.cameraSize / 100, height * .8)
      const x = (width - size) * settings.cameraX / 100
      const y = (height - size) * settings.cameraY / 100
      const fw = face.displayWidth, fh = face.displayHeight, crop = Math.min(fw, fh)
      ctx.save()
      ctx.beginPath(); ctx.roundRect(x, y, size, size, size / 2 * settings.roundness / 100); ctx.clip()
      if (settings.mirror) { ctx.translate(x * 2 + size, 0); ctx.scale(-1, 1) }
      ctx.drawImage(face, (fw - crop) / 2, (fh - crop) / 2, crop, crop, x, y, size, size)
      ctx.restore()
      if (settings.border) {
        ctx.strokeStyle = '#ed7899'; ctx.lineWidth = Math.max(2, width / 500)
        ctx.beginPath(); ctx.roundRect(x, y, size, size, size / 2 * settings.roundness / 100); ctx.stroke()
      }
    }
    const frame = new VideoFrame(ctx.canvas, { timestamp })
    try { await writer.write(frame) } finally { frame.close() }
  } finally { writing = false }
}
async function readFrames(reader: ReadableStreamDefaultReader<VideoFrame>, camera: boolean) {
  while (!stopped) {
    const { value, done } = await reader.read()
    if (done) break
    if (stopped) { value.close(); break }
    // At most one cached frame per input plus one output write. Backpressure
    // drops obsolete frames, not into an ever-growing decoded-frame queue.
    if (camera) { face?.close(); face = value }
    else {
      screen?.close(); screen = value
      clockOffset ??= value.timestamp - performance.now() * 1000
    }
    // Either input drives composition: a static screen must not freeze a moving camera.
    void render().catch(fail)
  }
  if (!camera && !stopped) { scope.postMessage({ ended: true }); void stop() }
}
scope.onmessage = ({ data }) => {
  if (data.action === 'settings') { settings = data.settings; return }
  if (data.action === 'stop') { void stop(); return }
  if (data.action !== 'start') return
  settings = data.settings
  screenReader = (data.screen as ReadableStream<VideoFrame>).getReader()
  if (data.camera) cameraReader = (data.camera as ReadableStream<VideoFrame>).getReader()
  writer = (data.output as WritableStream<VideoFrame>).getWriter()
  ctx = new OffscreenCanvas(data.width, data.height).getContext('2d', { alpha: false })!
  scope.postMessage({ ready: true })
  if (cameraReader) void readFrames(cameraReader, true).catch(fail)
  void readFrames(screenReader, false).catch(fail)
}
