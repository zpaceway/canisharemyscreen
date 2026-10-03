// Synchronous OPFS access belongs in a worker. Flush before acknowledging each chunk.
const scope = self as unknown as DedicatedWorkerGlobalScope
let access: FileSystemSyncAccessHandle | undefined
let offset = 0
scope.onmessage = async ({ data }) => {
  const { request, action, id, buffer } = data
  try {
    if (action === 'open') {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('cms-recordings', { create: true })
      const file = await dir.getFileHandle(`${id}.webm`, { create: true })
      access = await file.createSyncAccessHandle()
      access.truncate(0)
      offset = 0
    } else if (action === 'append') {
      if (!access) throw new Error('Recording storage is not open.')
      const bytes = new Uint8Array(buffer)
      let written = 0
      try {
        while (written < bytes.length) {
          const n = access.write(bytes.subarray(written), { at: offset + written })
          if (!n) throw new Error('Disk writing stopped. Free up space and export the saved recording.')
          written += n
        }
        access.flush()
        offset += written
      } catch (error) { access.truncate(offset); access.flush(); throw error }
    } else if (action === 'close') {
      access?.flush()
      access?.close()
      access = undefined
    }
    scope.postMessage({ request, bytes: offset })
  } catch (error) {
    scope.postMessage({ request, error: error instanceof Error ? error.message : String(error) })
  }
}
