import type { Settings } from './settings'

// Chromium's insertable-stream APIs expose captured frames without HTML video
// playback or a main-thread animation/timer loop in the recording path.
export function supportsFrameCompositor() {
  return typeof MediaStreamTrackProcessor === 'function'
    && typeof MediaStreamTrackGenerator === 'function'
    && typeof VideoFrame === 'function'
    && typeof OffscreenCanvas === 'function'
}
export class FrameCompositor {
  readonly track = new MediaStreamTrackGenerator({ kind: 'video' })
  private worker = new Worker(new URL('./compositor.worker.ts', import.meta.url), { type: 'module' })
  private inputs: MediaStreamTrack[] = []
  private closed = false
  start(screen: MediaStreamVideoTrack, camera: MediaStreamVideoTrack | undefined, settings: Settings, width: number, height: number, handlers: { onError: (message: string) => void; onSourceEnded: () => void }) {
    const display = screen.clone()
    this.inputs.push(display)
    const screenFrames = new MediaStreamTrackProcessor({ track: display, maxBufferSize: 1 }).readable
    let cameraFrames: ReadableStream<VideoFrame> | undefined
    if (camera) {
      const face = camera.clone()
      this.inputs.push(face)
      cameraFrames = new MediaStreamTrackProcessor({ track: face, maxBufferSize: 1 }).readable
    }
    return new Promise<void>((resolve, reject) => {
      let ready = false
      const timeout = setTimeout(() => { this.close(); reject(new Error('Frame compositor did not start. Choose your screen again.')) }, 10_000)
      const fail = (message: string, ended = false) => {
        clearTimeout(timeout)
        if (this.closed) return
        if (!ready) { this.close(); reject(new Error(ended ? 'Screen sharing ended before recording could start. Choose your screen again.' : message)) }
        else if (ended) handlers.onSourceEnded()
        else handlers.onError(message)
      }
      this.worker.onmessage = ({ data }) => {
        if (data.ready) { ready = true; clearTimeout(timeout); resolve() }
        if (data.error) fail(data.error)
        if (data.ended) fail('Screen sharing ended.', true)
      }
      this.worker.onerror = () => fail('The frame compositor stopped. Your saved recording is retained.')
      try {
        const output = this.track.writable
        const transfer: Transferable[] = [screenFrames, output]
        if (cameraFrames) transfer.push(cameraFrames)
        this.worker.postMessage({ action: 'start', screen: screenFrames, camera: cameraFrames, output, settings, width, height }, transfer)
      } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
    })
  }
  update(settings: Settings) { if (!this.closed) this.worker.postMessage({ action: 'settings', settings }) }
  close() {
    if (this.closed) return
    this.closed = true
    this.inputs.forEach(t => t.stop())
    this.track.stop()
    this.worker.postMessage({ action: 'stop' })
    this.worker.terminate()
  }
}
