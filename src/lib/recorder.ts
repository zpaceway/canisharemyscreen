import { DiskWriter, persistSession } from './storage'
import type { Session } from './storage'
import { videoBitrate } from './settings'
import type { Settings } from './settings'
import { FrameCompositor, supportsFrameCompositor } from './compositor'

type Callbacks = {
  onStats: (seconds: number, bytes: number) => void;
  onStopped: (session: Session) => void;
  onWarning: (message: string) => void;
  onSourceLost: () => void;
}
const MAX_PENDING_BYTES = 32 * 1024 * 1024
export class Recorder {
  readonly canvas = document.createElement('canvas')
  private screen = document.createElement('video')
  private face = document.createElement('video')
  private mediaHost = document.createElement('div')
  private display?: MediaStream
  private devices?: MediaStream
  private context?: AudioContext
  private destination?: MediaStreamAudioDestinationNode
  private micGain?: GainNode
  private systemGain?: GainNode
  private analyser?: AnalyserNode
  private meterData?: Uint8Array<ArrayBuffer>
  private systemAnalyser?: AnalyserNode
  private systemMeterData?: Uint8Array<ArrayBuffer>
  private deviceSignature = ''
  private deviceGeneration = 0
  private mediaRecorder?: MediaRecorder
  private compositor?: FrameCompositor
  private writer?: DiskWriter
  private session?: Session
  private writes = Promise.resolve()
  private pendingBytes = 0
  private diskFailed = false
  private droppedData = false
  private drawTimer?: ReturnType<typeof setInterval>
  private statsTimer?: ReturnType<typeof setInterval>
  private wakeLock?: WakeLockSentinel
  private began = 0
  private pausedAt = 0
  private pausedMs = 0
  private stopPromise?: Promise<void>
  private resolveStop?: () => void
  private disposed = false
  recording = false
  paused = false
  sourceName = ''
  hasSystemAudio = false
  hasLiveSource() { return !this.disposed && this.display?.getVideoTracks()[0]?.readyState === 'live' }
  usesFrameCompositor() { return !!this.compositor && !this.disposed }

  private settings: Settings
  private callbacks: Callbacks
  constructor(settings: Settings, callbacks: Callbacks) {
    this.settings = settings
    this.callbacks = callbacks
    this.screen.muted = this.face.muted = true
    this.screen.playsInline = this.face.playsInline = true
    // Keep source media connected while play() is pending and throughout capture.
    // Removing/detaching live media can abort playback in Chromium. Do not use
    // display:none: the videos must keep supplying frames to the compositor.
    this.mediaHost.setAttribute('aria-hidden', 'true')
    this.mediaHost.inert = true
    Object.assign(this.mediaHost.style, {
      position: 'fixed', left: '-10000px', top: '0', width: '1px', height: '1px',
      overflow: 'hidden', pointerEvents: 'none',
    })
    this.screen.width = this.face.width = 1
    this.screen.height = this.face.height = 1
    this.mediaHost.append(this.screen, this.face)
    document.body.append(this.mediaHost)
    this.canvas.width = 1920; this.canvas.height = 1080
  }
  update(settings: Settings) {
    this.settings = settings
    this.compositor?.update(settings)
    if (this.micGain) this.micGain.gain.value = settings.micVolume / 100
    if (this.systemGain) this.systemGain.gain.value = settings.systemAudio ? settings.systemVolume / 100 : 0
  }
  async prepare() {
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      throw new Error('Screen recording needs a supported desktop browser. Open this page in Chrome or Edge over HTTPS or localhost.')
    }
    if (!navigator.storage?.getDirectory) throw new Error('This browser has no disk-backed recording storage. Use desktop Chrome or Edge.')
    // These are picker hints, not guarantees. Unsupported browsers ignore them.
    const captureOptions: DisplayMediaStreamOptions & {
      systemAudio: 'include' | 'exclude'; windowAudio: 'system' | 'exclude';
      audio: boolean | (MediaTrackConstraints & { suppressLocalAudioPlayback: boolean });
    } = {
      video: { frameRate: { ideal: this.settings.fps }, displaySurface: 'monitor' },
      audio: this.settings.systemAudio ? { suppressLocalAudioPlayback: false } : false,
      systemAudio: this.settings.systemAudio ? 'include' : 'exclude',
      windowAudio: this.settings.systemAudio ? 'system' : 'exclude',
    }
    this.display = await navigator.mediaDevices.getDisplayMedia(captureOptions)
    if (this.disposed) { this.display.getTracks().forEach(t => t.stop()); return }
    const track = this.display.getVideoTracks()[0]
    this.sourceName = track.label || 'Selected screen'
    this.hasSystemAudio = this.display.getAudioTracks().length > 0
    if (this.settings.systemAudio && !this.hasSystemAudio) {
      this.callbacks.onWarning('This source didn’t provide audio. Choose a browser tab and enable “Share audio”, or use a supported system-audio source.')
    }
    track.onended = () => {
      if (this.recording) void this.stop()
      else { this.dispose(); this.callbacks.onSourceLost() }
    }
    this.screen.srcObject = this.display
    try { await this.screen.play() }
    catch (error) { if (this.disposed) return; throw error }
    if (this.disposed) return
    this.resize()
    await this.configureDevices()
    if (this.disposed) return
    this.draw()
    // Preview only. Recording uses captured frames in a worker, not this timer.
    this.drawTimer = setInterval(() => this.draw(), 1000 / this.settings.fps)
  }
  private resize() {
    const sw = this.screen.videoWidth || 1920, sh = this.screen.videoHeight || 1080
    const ratio = Math.min(1, (this.settings.resolution || sh) / sh)
    this.canvas.width = Math.max(2, Math.floor(sw * ratio / 2) * 2)
    this.canvas.height = Math.max(2, Math.floor(sh * ratio / 2) * 2)
  }
  async configureDevices() {
    if (this.recording || this.disposed) return
    const s = this.settings
    const signature = JSON.stringify([s.camera, s.cameraDevice, s.mic, s.micDevice, s.noiseSuppression, s.echoCancellation])
    if (this.deviceSignature === signature) return
    const generation = ++this.deviceGeneration
    const stream = (s.camera || s.mic) ? await navigator.mediaDevices.getUserMedia({
      video: s.camera ? {
        ...(s.cameraDevice ? { deviceId: { exact: s.cameraDevice } } : { facingMode: 'user' }),
        width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: 30 },
      } : false,
      audio: s.mic ? {
        ...(s.micDevice ? { deviceId: { exact: s.micDevice } } : {}),
        noiseSuppression: s.noiseSuppression, echoCancellation: s.echoCancellation,
      } : false,
    }) : undefined
    if (generation !== this.deviceGeneration || this.disposed) { stream?.getTracks().forEach(t => t.stop()); return }
    this.devices?.getTracks().forEach(t => t.stop())
    this.devices = stream
    this.deviceSignature = signature
    this.face.srcObject = stream && s.camera ? new MediaStream(stream.getVideoTracks()) : null
    if (s.camera) {
      try { await this.face.play() }
      catch (error) {
        if (this.disposed || generation !== this.deviceGeneration) return
        this.deviceSignature = ''
        throw error
      }
    }
    if (this.disposed || generation !== this.deviceGeneration) return
    await this.setupAudio()
  }
  private async setupAudio() {
    await this.context?.close()
    this.context = undefined; this.analyser = undefined; this.destination = undefined
    this.micGain = undefined; this.systemGain = undefined; this.meterData = undefined
    this.systemAnalyser = undefined; this.systemMeterData = undefined
    const micTrack = this.devices?.getAudioTracks()[0]
    const systemTrack = this.display?.getAudioTracks()[0]
    if (!micTrack && !systemTrack) return
    const context = new AudioContext()
    this.context = context
    this.destination = context.createMediaStreamDestination()
    if (micTrack) {
      const source = context.createMediaStreamSource(new MediaStream([micTrack]))
      this.micGain = context.createGain()
      this.micGain.gain.value = this.settings.micVolume / 100
      this.analyser = context.createAnalyser()
      this.analyser.fftSize = 256
      this.meterData = new Uint8Array(256)
      source.connect(this.micGain).connect(this.analyser).connect(this.destination)
    }
    if (systemTrack) {
      this.systemGain = context.createGain()
      this.systemGain.gain.value = this.settings.systemAudio ? this.settings.systemVolume / 100 : 0
      this.systemAnalyser = context.createAnalyser()
      this.systemAnalyser.fftSize = 256
      this.systemMeterData = new Uint8Array(256)
      context.createMediaStreamSource(new MediaStream([systemTrack])).connect(this.systemGain).connect(this.systemAnalyser).connect(this.destination)
    }
    await context.resume()
  }
  meter(input: 'mic' | 'system' = 'mic') {
    if (this.disposed) return 0
    const analyser = input === 'system' ? this.systemAnalyser : this.analyser
    const data = input === 'system' ? this.systemMeterData : this.meterData
    if (!analyser || !data) return 0
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (const n of data) sum += ((n - 128) / 128) ** 2
    return Math.min(1, Math.sqrt(sum / data.length) * 4)
  }
  private draw() {
    const ctx = this.canvas.getContext('2d', { alpha: false })!
    const w = this.canvas.width, h = this.canvas.height
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h)
    if (this.screen.readyState >= 2) ctx.drawImage(this.screen, 0, 0, w, h)
    const s = this.settings
    if (!s.camera || this.face.readyState < 2) return
    const size = Math.min(w * s.cameraSize / 100, h * .8)
    const x = (w - size) * s.cameraX / 100, y = (h - size) * s.cameraY / 100
    const fw = this.face.videoWidth, fh = this.face.videoHeight, crop = Math.min(fw, fh)
    ctx.save()
    ctx.beginPath(); ctx.roundRect(x, y, size, size, size / 2 * s.roundness / 100); ctx.clip()
    if (s.mirror) { ctx.translate(x * 2 + size, 0); ctx.scale(-1, 1) }
    ctx.drawImage(this.face, (fw - crop) / 2, (fh - crop) / 2, crop, crop, x, y, size, size)
    ctx.restore()
    if (s.border) {
      ctx.strokeStyle = '#ed7899'; ctx.lineWidth = Math.max(2, w / 500)
      ctx.beginPath(); ctx.roundRect(x, y, size, size, size / 2 * s.roundness / 100); ctx.stroke()
    }
  }
  private seconds() { return Math.max(0, ((this.paused ? this.pausedAt : performance.now()) - this.began - this.pausedMs) / 1000) }
  async start() {
    if (!this.display || this.display.getVideoTracks()[0].readyState !== 'live') throw new Error('Choose your screen before recording.')
    await this.configureDevices()
    if (this.settings.camera && !this.devices?.getVideoTracks().length) throw new Error('Camera isn’t ready. Allow camera access or turn it off.')
    if (this.settings.mic && !this.devices?.getAudioTracks().length) throw new Error('Microphone isn’t ready. Allow mic access or turn it off.')
    await navigator.storage.persist?.().catch(() => false)
    const estimate = await navigator.storage.estimate()
    if (estimate.quota && estimate.quota - (estimate.usage || 0) < 128 * 1024 * 1024) throw new Error('Not enough recording storage. Export previous recordings and free up disk space.')
    this.resize()
    clearInterval(this.drawTimer)
    this.drawTimer = setInterval(() => this.draw(), 1000 / this.settings.fps)
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
    if (!mime) throw new Error('This browser cannot record WebM. Use desktop Chrome or Edge.')
    this.draw()
    let stream: MediaStream
    if (supportsFrameCompositor()) {
      this.compositor = new FrameCompositor()
      try {
        await this.compositor.start(this.display.getVideoTracks()[0], this.devices?.getVideoTracks()[0], this.settings, this.canvas.width, this.canvas.height, {
          onError: message => {
            this.callbacks.onWarning(message)
            if (this.recording) { this.droppedData = true; void this.stop() }
          },
          // Native capture ending is a normal stop; encoded frames flush on stop.
          onSourceEnded: () => { if (this.recording) void this.stop() },
        })
      } catch (error) { this.compositor.close(); this.compositor = undefined; throw error }
      stream = new MediaStream([this.compositor.track])
    } else {
      this.callbacks.onWarning('This browser uses canvas recording. Keep the recorder tab active to avoid background frame-rate throttling. Current desktop Chrome or Edge supports frame-driven recording.')
      stream = this.canvas.captureStream(this.settings.fps)
    }
    this.destination?.stream.getAudioTracks().forEach(t => stream.addTrack(t.clone()))
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBitrate(this.settings), audioBitsPerSecond: 128_000 })
    this.session = {
      id: crypto.randomUUID(), created: Date.now(), bytes: 0, seconds: 0,
      width: this.canvas.width, height: this.canvas.height, settings: { ...this.settings }, complete: false,
    }
    this.writer = new DiskWriter()
    try {
      await this.writer.open(this.session.id)
      if (!this.hasLiveSource()) throw new Error('Screen sharing ended before recording could start. Choose your screen again.')
      persistSession(this.session)
    } catch (error) {
      await this.writer.close().catch(() => {})
      stream.getTracks().forEach(t => t.stop())
      this.compositor?.close(); this.compositor = undefined
      this.mediaRecorder = undefined
      throw error
    }
    this.stopPromise = new Promise(resolve => { this.resolveStop = resolve })
    this.diskFailed = false; this.droppedData = false
    this.mediaRecorder.ondataavailable = ({ data }) => {
      if (!data.size || this.diskFailed || this.droppedData) return
      if (this.pendingBytes + data.size > MAX_PENDING_BYTES) {
        this.droppedData = true
        this.callbacks.onWarning('Recording stopped because disk writing fell behind or the browser produced an oversized chunk. The saved portion is retained.')
        void this.stop(); return
      }
      this.pendingBytes += data.size
      const seconds = this.seconds()
      this.writes = this.writes.then(async () => {
        if (this.diskFailed) return
        this.session!.bytes = await this.writer!.append(await data.arrayBuffer())
        this.session!.seconds = seconds
        persistSession(this.session!)
      }).catch(error => {
        this.diskFailed = true
        this.callbacks.onWarning(`Recording stopped: ${error instanceof Error ? error.message : String(error)} Your saved portion is retained.`)
        void this.stop()
      }).finally(() => { this.pendingBytes -= data.size })
    }
    this.mediaRecorder.onerror = () => { this.droppedData = true; this.callbacks.onWarning('The browser stopped encoding. Your saved portion is retained.'); void this.stop() }
    this.mediaRecorder.onstop = () => { void this.finish(stream) }
    this.began = performance.now(); this.pausedMs = 0; this.paused = false
    await this.context?.resume()
    this.recording = true
    this.mediaRecorder.start(1000)
    this.statsTimer = setInterval(() => {
      this.callbacks.onStats(this.seconds(), this.session?.bytes || 0)
    }, 250)
    void this.acquireWakeLock()
  }
  async acquireWakeLock() {
    if (!this.recording || document.visibilityState !== 'visible') return
    try { this.wakeLock = await navigator.wakeLock?.request('screen') } catch { /* OS policy may deny a wake lock. */ }
  }
  pause() {
    if (!this.mediaRecorder || !this.recording) return
    if (this.paused) {
      this.pausedMs += performance.now() - this.pausedAt
      this.paused = false; this.mediaRecorder.resume()
    } else { this.pausedAt = performance.now(); this.paused = true; this.mediaRecorder.pause() }
  }
  stop(): Promise<void> {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop()
    return this.stopPromise || Promise.resolve()
  }
  private async finish(stream: MediaStream) {
    this.recording = false
    clearInterval(this.statsTimer)
    await this.writes
    try { await this.writer?.close() } catch (error) { this.diskFailed = true; this.callbacks.onWarning(String(error)) }
    stream.getTracks().forEach(t => t.stop())
    if (this.session) {
      this.session.complete = !this.diskFailed && !this.droppedData
      try { persistSession(this.session) } catch { this.callbacks.onWarning('Recovery metadata could not be saved. Download this recording before closing the page.') }
      this.callbacks.onStats(this.session.seconds, this.session.bytes)
      this.dispose()
      this.callbacks.onStopped({ ...this.session })
    }
    this.resolveStop?.()
  }
  dispose() {
    this.disposed = true; this.deviceGeneration++
    clearInterval(this.drawTimer); clearInterval(this.statsTimer)
    this.compositor?.close(); this.compositor = undefined
    this.display?.getTracks().forEach(t => { t.onended = null; t.stop() })
    this.devices?.getTracks().forEach(t => t.stop())
    this.screen.pause(); this.face.pause()
    this.screen.srcObject = this.face.srcObject = null
    this.mediaHost.remove()
    void this.context?.close().catch(() => {})
    void this.wakeLock?.release().catch(() => {})
  }
}
