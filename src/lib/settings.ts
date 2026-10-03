export type Settings = {
  resolution: number; fps: number; quality: 'low' | 'balanced' | 'high'; bitrate: number;
  countdown: boolean; camera: boolean; cameraDevice: string; cameraSize: number;
  cameraX: number; cameraY: number; roundness: number; mirror: boolean; border: boolean;
  mic: boolean; micDevice: string; systemAudio: boolean; micVolume: number;
  systemVolume: number; noiseSuppression: boolean; echoCancellation: boolean;
  format: 'webm' | 'mp4'; compression: 'original' | 'balanced' | 'small';
}
export const defaults: Settings = {
  resolution: 1080, fps: 30, quality: 'balanced', bitrate: 0, countdown: true,
  camera: false, cameraDevice: '', cameraSize: 18, cameraX: 96, cameraY: 94,
  roundness: 100, mirror: true, border: false, mic: false, micDevice: '',
  systemAudio: false, micVolume: 100, systemVolume: 100,
  noiseSuppression: true, echoCancellation: true, format: 'webm', compression: 'original',
}
const key = 'cms:preferences:v1'
export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}') as Partial<Settings>
    const result = { ...defaults }
    for (const name of Object.keys(defaults) as (keyof Settings)[]) {
      if (typeof saved[name] === typeof defaults[name]) Object.assign(result, { [name]: saved[name] })
    }
    if (![0, 720, 1080, 1440, 2160].includes(result.resolution)) result.resolution = 1080
    if (![24, 30, 60].includes(result.fps)) result.fps = 30
    if (!['low', 'balanced', 'high'].includes(result.quality)) result.quality = 'balanced'
    if (!['webm', 'mp4'].includes(result.format)) result.format = 'webm'
    if (!['original', 'balanced', 'small'].includes(result.compression)) result.compression = 'original'
    for (const name of ['cameraX', 'cameraY', 'roundness', 'micVolume', 'systemVolume'] as const) {
      result[name] = Math.max(0, Math.min(100, result[name]))
    }
    result.cameraSize = Math.max(10, Math.min(35, result.cameraSize))
    result.bitrate = Math.max(0, Math.min(50, result.bitrate))
    return result
  } catch { return { ...defaults } }
}
export function saveSettings(settings: Settings) {
  try { localStorage.setItem(key, JSON.stringify(settings)) } catch { /* Preferences are optional. */ }
}
export function videoBitrate(s: Settings) {
  return (s.bitrate || (s.quality === 'high' ? 12 : s.quality === 'low' ? 3 : 6)) * 1e6
}
export function formatBytes(bytes: number) {
  const unit = bytes >= 1e9 ? 'GB' : bytes >= 1e6 ? 'MB' : 'KB'
  const value = bytes / (unit === 'GB' ? 1e9 : unit === 'MB' ? 1e6 : 1e3)
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} ${unit}`
}
export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':')
}
export function errorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Permission wasn’t granted. Choose your screen again and allow access.'
    if (error.name === 'NotFoundError') return 'That device isn’t available. Connect it or choose another device.'
    if (error.name === 'NotReadableError') return 'The device is in use or unavailable. Close other apps using it and try again.'
    if (error.name === 'QuotaExceededError') return 'Storage is full. Your saved recording is retained. Export it, then free up disk space.'
  }
  return error instanceof Error ? error.message : 'Something went wrong. Try again; your saved recording is retained.'
}
