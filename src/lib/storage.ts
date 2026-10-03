import type { Settings } from './settings'

export type Session = {
  id: string; created: number; bytes: number; seconds: number;
  width: number; height: number; settings: Settings; complete: boolean;
}
const prefix = 'cms:recording:v1:'
export function persistSession(session: Session) { localStorage.setItem(prefix + session.id, JSON.stringify(session)) }
export function listSessions(): Session[] {
  const sessions: Session[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!
    if (!key.startsWith(prefix)) continue
    try {
      const s = JSON.parse(localStorage.getItem(key)!) as Session
      if (/^[a-z0-9-]+$/i.test(s.id) && key === prefix + s.id
        && Number.isFinite(s.created) && s.created > 0 && s.created < 8.64e15
        && Number.isFinite(s.bytes) && s.bytes >= 0
        && Number.isFinite(s.seconds) && s.seconds >= 0
        && Number.isFinite(s.width) && s.width > 0 && Number.isFinite(s.height) && s.height > 0
        && s.settings && typeof s.settings === 'object') sessions.push(s)
    } catch { /* A damaged manifest must not block other recovery entries. */ }
  }
  return sessions.sort((a, b) => b.created - a.created)
}
export async function sessionFile(session: Session) {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle('cms-recordings')
  const file = await (await dir.getFileHandle(`${session.id}.webm`)).getFile()
  // Ignore an unacknowledged tail after a crash, without reading the file into RAM.
  return file.slice(0, Math.min(session.bytes, file.size), 'video/webm')
}
export async function deleteSession(session: Session) {
  const root = await navigator.storage.getDirectory()
  try {
    const dir = await root.getDirectoryHandle('cms-recordings')
    await dir.removeEntry(`${session.id}.webm`)
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
  }
  localStorage.removeItem(prefix + session.id)
}
export class DiskWriter {
  private worker = new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' })
  private sequence = 0
  private broken = false
  private pending = new Map<number, { resolve: (bytes: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  constructor() {
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.request)
      if (!pending) return
      this.pending.delete(data.request)
      clearTimeout(pending.timer)
      if (data.error) pending.reject(new Error(data.error))
      else pending.resolve(data.bytes)
    }
    this.worker.onerror = () => this.fail(new Error('Storage worker stopped. Reopen the app to recover saved data.'))
  }
  private fail(error: Error) {
    this.broken = true
    this.pending.forEach(p => { clearTimeout(p.timer); p.reject(error) })
    this.pending.clear()
  }
  private call(action: string, extra: object = {}, transfer: Transferable[] = []) {
    return new Promise<number>((resolve, reject) => {
      if (this.broken) { reject(new Error('Recording storage is unavailable. Reopen the app to recover saved data.')); return }
      const request = ++this.sequence
      const timer = setTimeout(() => {
        this.fail(new Error('Disk writing timed out. Recording stopped to protect memory; saved chunks are retained.'))
        this.worker.terminate()
      }, 30_000)
      this.pending.set(request, { resolve, reject, timer })
      this.worker.postMessage({ request, action, ...extra }, transfer)
    })
  }
  open(id: string) { return this.call('open', { id }) }
  append(buffer: ArrayBuffer) { return this.call('append', { buffer }, [buffer]) }
  async close() {
    try { await this.call('close') } finally { this.worker.terminate(); this.fail(new Error('Storage closed.')) }
  }
}
