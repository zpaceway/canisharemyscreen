import { useCallback, useEffect, useRef, useState } from 'react'
import { Recorder } from '../lib/recorder'
import { errorMessage, loadSettings, saveSettings, defaults } from '../lib/settings'
import type { Settings } from '../lib/settings'
import { deleteSession, listSessions, sessionFile } from '../lib/storage'
import type { Session } from '../lib/storage'
import { checkExportSupport, chooseDestination, runExport, saveOriginal } from '../lib/export'
import type { ExportSupport } from '../lib/export'

export type StudioStatus = 'idle' | 'choosing' | 'ready' | 'countdown' | 'starting' | 'recording' | 'paused' | 'stopping' | 'review' | 'exporting'
export function useStudio() {
  const [settings, setSettings] = useState(loadSettings)
  const [status, setStatus] = useState<StudioStatus>('idle')
  const [notice, setNoticeState] = useState('')
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [bytes, setBytes] = useState(0)
  const [countdown, setCountdown] = useState(0)
  const [session, setSession] = useState<Session | null>(null)
  const [reviewUrl, setReviewUrl] = useState('')
  const [recoveries, setRecoveries] = useState<Session[]>(() => { try { return listSessions() } catch { return [] } })
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [sourceName, setSourceName] = useState('')
  const [hasSystemAudio, setHasSystemAudio] = useState(false)
  const [progress, setProgress] = useState(0)
  const [deviceBusy, setDeviceBusy] = useState(false)
  const [canCancelExport, setCanCancelExport] = useState(false)
  const [exportSupport, setExportSupport] = useState<ExportSupport | null>(null)
  const engine = useRef<Recorder | null>(null)
  const previewHost = useRef<HTMLDivElement>(null)
  const countdownToken = useRef(0)
  const cancelExport = useRef<(() => void) | null>(null)
  const statusRef = useRef(status)
  const settingsRef = useRef(settings)
  useEffect(() => { statusRef.current = status }, [status])

  // Notices are informational, so they clear themselves; errors stay until dismissed.
  function setNotice(message: string) {
    if (noticeTimer.current) { clearTimeout(noticeTimer.current); noticeTimer.current = null }
    setNoticeState(message)
    if (message) noticeTimer.current = setTimeout(() => { setNoticeState(''); noticeTimer.current = null }, 5000)
  }

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    const next = { ...settingsRef.current, [key]: value }
    settingsRef.current = next
    setSettings(next); saveSettings(next); engine.current?.update(next)
    if (statusRef.current === 'ready' && engine.current && ['camera', 'cameraDevice', 'mic', 'micDevice', 'noiseSuppression', 'echoCancellation'].includes(key)) {
      setDeviceBusy(true)
      engine.current.configureDevices().then(refreshDevices).catch(e => setError(errorMessage(e))).finally(() => setDeviceBusy(false))
    }
  }
  function refreshRecoveries() { try { setRecoveries(listSessions()) } catch { setRecoveries([]) } }
  function resetSettings() {
    const next = { ...defaults }
    settingsRef.current = next
    setSettings(next); saveSettings(next); engine.current?.update(next)
    setError(''); setNotice('Settings restored to their defaults.')
    if (statusRef.current === 'ready' && engine.current) {
      setDeviceBusy(true)
      engine.current.configureDevices().then(refreshDevices).catch(e => setError(errorMessage(e))).finally(() => setDeviceBusy(false))
    }
  }
  function probeExport() { void checkExportSupport(session?.width, session?.height).then(setExportSupport) }
  async function refreshDevices() {
    try { const available = await navigator.mediaDevices.enumerateDevices(); setDevices(available) } catch { /* Devices may be hidden before permission. */ }
  }
  useEffect(() => {
    // Initial device reads are asynchronous external-system synchronization.
    void Promise.resolve().then(refreshDevices)
    const interval = setInterval(() => {
      if (engine.current?.recording) {
        void navigator.storage.estimate().then(estimate => {
          if (estimate.quota && estimate.quota - (estimate.usage || 0) < 64 * 1024 * 1024) {
            setNotice('Recording stopped before storage filled up. Export your recording, then free up space.')
            setStatus('stopping'); void engine.current?.stop()
          }
        }).catch(() => {})
      }
    }, 10_000)
    const visibility = () => {
      if (!engine.current?.recording) return
      if (document.hidden) setNotice(engine.current.usesFrameCompositor()
        ? 'Recording continues in the background. Avoid device sleep; the browser can still suspend capture.'
        : 'This browser uses canvas recording. Keep the recorder tab active to avoid background frame-rate throttling.')
      else void engine.current.acquireWakeLock()
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (engine.current?.recording || ['countdown', 'starting', 'exporting', 'stopping'].includes(statusRef.current)) {
        event.preventDefault()
      }
    }
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      clearInterval(interval)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('beforeunload', beforeUnload)
      // These are controller refs, not DOM nodes; cleanup deliberately uses the latest job.
      cleanupControllers()
    }
  }, [])
  function cleanupControllers() {
    countdownToken.current++
    cancelExport.current?.()
    if (engine.current?.recording) void engine.current.stop()
    else engine.current?.dispose()
  }
  useEffect(() => {
    if (!session) return
    let url = '', active = true
    sessionFile(session).then(blob => {
      if (!active) return
      url = URL.createObjectURL(blob); setReviewUrl(url)
    }).catch(e => { if (active) setError(errorMessage(e)) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [session])

  async function chooseScreen() {
    if (!['idle', 'ready'].includes(statusRef.current)) return
    setError(''); setNotice(''); setStatus('choosing'); setHasSystemAudio(false)
    engine.current?.dispose()
    const recorder = new Recorder(settingsRef.current, {
      onStats: (time, size) => { setSeconds(time); setBytes(size) },
      onWarning: setNotice,
      onSourceLost: () => { countdownToken.current++; setStatus('idle'); setSourceName(''); setHasSystemAudio(false); setNotice('Screen sharing ended. Choose your screen to try again.') },
      onStopped: saved => {
        setSession(saved); setStatus('review'); refreshRecoveries()
      },
    })
    engine.current = recorder
    try {
      await recorder.prepare()
      if (!recorder.hasLiveSource()) throw new Error('Screen sharing ended. Choose your screen again.')
      previewHost.current?.replaceChildren(recorder.canvas)
      setSourceName(recorder.sourceName); setHasSystemAudio(recorder.hasSystemAudio); setStatus('ready'); void refreshDevices()
    } catch (e) {
      recorder.dispose(); setStatus('idle'); setSourceName(''); setError(errorMessage(e))
    }
  }
  async function start() {
    if (statusRef.current !== 'ready' || !engine.current || deviceBusy) return
    setError(''); setSeconds(0); setBytes(0)
    const token = ++countdownToken.current
    if (settings.countdown) {
      setStatus('countdown')
      for (let n = 3; n > 0; n--) {
        setCountdown(n)
        await new Promise(resolve => setTimeout(resolve, 1000))
        if (countdownToken.current !== token) return
      }
    }
    setCountdown(0); setStatus('starting')
    try { await engine.current.start(); setStatus('recording') }
    catch (e) {
      setError(errorMessage(e))
      setStatus(engine.current?.hasLiveSource() ? 'ready' : 'idle')
      if (!engine.current?.hasLiveSource()) setSourceName('')
    }
  }
  function cancelCountdown() { countdownToken.current++; setCountdown(0); setStatus('ready') }
  function pause() {
    engine.current?.pause()
    setStatus(engine.current?.paused ? 'paused' : 'recording')
  }
  function stop() { setStatus('stopping'); void engine.current?.stop() }
  function recordAgain() {
    engine.current?.dispose(); engine.current = null
    setSession(null); setReviewUrl(''); setStatus('idle'); setSeconds(0); setBytes(0); setHasSystemAudio(false)
    setError(''); setNotice(''); refreshRecoveries()
  }
  async function recover(saved: Session) {
    if (!['idle', 'review'].includes(statusRef.current)) return
    setError('')
    try {
      const blob = await sessionFile(saved)
      if (!blob.size) throw new Error('No saved media remains for this recording. It may have been removed by the browser.')
      setSession(saved); setSeconds(saved.seconds); setBytes(saved.bytes); setStatus('review')
      setNotice(saved.complete ? '' : 'This session was interrupted. You can preview and export the saved portion; the last incomplete frames may be missing.')
    } catch (e) { setError(errorMessage(e)) }
  }
  async function discard(saved: Session) {
    try {
      await deleteSession(saved)
      if (session?.id === saved.id) recordAgain()
      refreshRecoveries()
    } catch (e) { setError(errorMessage(e)) }
  }
  async function download(original = false) {
    if (!session || statusRef.current !== 'review') return
    setError('')
    const direct = original || (settings.format === 'webm' && settings.compression === 'original')
    try {
      // Call the picker immediately, while the click's user activation is still live.
      const handle = typeof window.showSaveFilePicker === 'function' ? await chooseDestination(direct ? 'webm' : settings.format) : undefined
      if (!handle && !direct) throw new Error('MP4 and compression need streaming file export. Use desktop Chrome or Edge, or download the original WebM.')
      setProgress(0); setStatus('exporting')
      if (direct) { await saveOriginal(session, handle); setProgress(1) }
      else {
        const job = runExport(session, settings, handle!, setProgress)
        cancelExport.current = job.cancel
        setCanCancelExport(true)
        await job.promise
      }
      setNotice('Recording saved. The recovery copy stays here until you discard it.')
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError(errorMessage(e))
    } finally { cancelExport.current = null; setCanCancelExport(false); setStatus('review') }
  }
  const attachPreview = useCallback((node: HTMLDivElement | null) => {
    previewHost.current = node
    if (node && engine.current) node.replaceChildren(engine.current.canvas)
  }, [])
  const getCanvas = useCallback(() => engine.current?.canvas, [])
  const getMeter = useCallback((input: 'mic' | 'system' = 'mic') => engine.current?.meter(input) || 0, [])
  const cancelExportJob = useCallback(() => cancelExport.current?.(), [])
  return {
    settings, update, status, notice, error, setError, setNotice, seconds, bytes, countdown,
    session, reviewUrl, recoveries, devices, sourceName, hasSystemAudio, progress, deviceBusy, exportSupport, probeExport, resetSettings,
    attachPreview, getCanvas, getMeter,
    chooseScreen, start, cancelCountdown, pause, stop, recordAgain,
    recover, discard, download, canCancelExport, cancelExportJob,
  }
}
export type Studio = Omit<ReturnType<typeof useStudio>, 'attachPreview' | 'canCancelExport' | 'cancelExportJob'>
