import { Input, BlobSource, WEBM, Output, StreamTarget, Mp4OutputFormat, WebMOutputFormat, Conversion, Quality, canEncodeAudio, canEncodeVideo } from 'mediabunny'
import type { Session } from './storage'
import type { Settings } from './settings'

const scope = self as unknown as DedicatedWorkerGlobalScope
let conversion: Conversion | undefined
let canceled = false
scope.onmessage = async ({ data }) => {
  if (data.action === 'probe') {
    try {
      const [mp4, webm] = await Promise.all([canEncodeVideo('avc', { width: data.width, height: data.height }), canEncodeVideo('vp8', { width: data.width, height: data.height })])
      scope.postMessage({ support: { mp4, webm } })
    } catch { scope.postMessage({ support: { mp4: false, webm: false } }) }
    return
  }
  if (data.action === 'cancel') { canceled = true; await conversion?.cancel(); return }
  const { blob, handle, settings, session } = data as {
    blob: Blob; handle: FileSystemFileHandle; settings: Settings; session: Session;
  }
  const input = new Input({ source: new BlobSource(blob, { maxCacheSize: 8 * 1024 * 1024 }), formats: [WEBM] })
  let writable: FileSystemWritableFileStream | undefined
  try {
    if (settings.format === 'mp4' && !(await canEncodeAudio('aac'))) {
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
      registerAacEncoder()
    }
    writable = await handle.createWritable()
    const file = writable
    // Commit the destination only on success. Cancellation aborts its temporary file.
    const target = new StreamTarget(new WritableStream({ write: chunk => file.write(chunk) }), { chunked: true, chunkSize: 1024 * 1024 })
    const small = settings.compression === 'small'
    const compressed = settings.compression !== 'original'
    const bitrate = Math.min(session.settings.bitrate || (session.settings.quality === 'high' ? 12 : session.settings.quality === 'low' ? 3 : 6), small ? 1.5 : 3.5) * 1e6
    const output = new Output({
      target,
      format: settings.format === 'mp4'
        ? new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 })
        : new WebMOutputFormat(),
    })
    conversion = await Conversion.init({
      input, output, tracks: 'primary',
      video: {
        codec: settings.format === 'mp4' ? 'avc' : 'vp8',
        ...(compressed ? {
          quality: new Quality({ bitrate }), forceTranscode: true,
          height: Math.min(session.height, small ? 720 : 1080), frameRate: Math.min(session.settings.fps, 30),
        } : {}),
      },
      audio: { codec: settings.format === 'mp4' ? 'aac' : 'opus' },
    })
    if (!conversion.isValid || conversion.discardedTracks.length) {
      const reasons = conversion.discardedTracks.map(t => `${t.track.type}: ${t.reason}`).join(', ')
      throw new Error(`${settings.format.toUpperCase()} export isn’t supported with these tracks (${reasons}). Choose Original WebM to keep all recorded audio and video.`)
    }
    if (canceled) { await conversion.cancel(); throw new Error('Export canceled.') }
    let lastProgress = 0
    conversion.onProgress = progress => {
      if (progress - lastProgress >= 0.005 || progress === 1) { lastProgress = progress; scope.postMessage({ progress }) }
    }
    await conversion.execute()
    if (canceled) throw new Error('Export canceled.')
    await file.close()
    writable = undefined
    scope.postMessage({ done: true })
  } catch (error) {
    await writable?.abort().catch(() => {})
    scope.postMessage({ error: canceled ? 'Export canceled. Your original recording is safe.' : error instanceof Error ? error.message : String(error) })
  } finally { input.dispose(); conversion = undefined }
}
