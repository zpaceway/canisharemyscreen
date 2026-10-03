import type { Session } from './storage'
import { sessionFile } from './storage'
import type { Settings } from './settings'

export type ExportSupport = { mp4: boolean; webm: boolean }
export function checkExportSupport(width = 1280, height = 720): Promise<ExportSupport> {
  const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
  return new Promise(resolve => {
    const finish = (support: ExportSupport) => { clearTimeout(timeout); worker.terminate(); resolve(support) }
    const timeout = setTimeout(() => finish({ mp4: false, webm: false }), 15_000)
    worker.onmessage = ({ data }) => { if (data.support) finish(data.support) }
    worker.onerror = () => finish({ mp4: false, webm: false })
    worker.postMessage({ action: 'probe', width, height })
  })
}

export function chooseDestination(format: Settings['format']) {
  if (!window.showSaveFilePicker) throw new Error('Streaming export needs desktop Chrome or Edge. You can still download the original WebM.')
  return window.showSaveFilePicker({
    suggestedName: `Recording ${new Date().toISOString().slice(0, 10)}.${format}`,
    types: [{ description: `${format.toUpperCase()} video`, accept: format === 'mp4' ? { 'video/mp4': ['.mp4'] } : { 'video/webm': ['.webm'] } }],
  })
}
export function runExport(session: Session, settings: Settings, handle: FileSystemFileHandle, onProgress: (n: number) => void) {
  const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' })
  const promise = new Promise<void>((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (typeof data.progress === 'number') onProgress(data.progress)
      if (data.done || data.error) {
        worker.terminate()
        if (data.error) reject(new Error(data.error)); else resolve()
      }
    }
    worker.onerror = () => { worker.terminate(); reject(new Error('Export worker stopped. Your original recording is retained; try Original WebM.')) }
    sessionFile(session).then(blob => worker.postMessage({ blob, settings, handle, session })).catch(error => { worker.terminate(); reject(error) })
  })
  return { promise, cancel: () => worker.postMessage({ action: 'cancel' }) }
}
export async function saveOriginal(session: Session, handle?: FileSystemFileHandle) {
  const blob = await sessionFile(session)
  if (handle) {
    const writable = await handle.createWritable()
    try { await blob.stream().pipeTo(writable) }
    catch (error) { await writable.abort().catch(() => {}); throw error }
  } else {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `Recording ${new Date(session.created).toISOString().slice(0, 10)}.webm`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
