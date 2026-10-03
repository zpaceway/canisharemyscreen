import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowUpRight, Circle, CircleAlert, CircleStop, Expand, LoaderCircle, Pause, Play, RotateCcw, ScreenShare, Settings2, ShieldCheck, X } from 'lucide-react'
import type { MouseEvent, PointerEvent, ReactNode } from 'react'
import { useStudio } from './hooks/useStudio'
import type { Session } from './lib/storage'
import { formatBytes, formatTime } from './lib/settings'
import { SettingsPanel, SetupChips } from './components/SettingsPanel'

function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  // A backdrop click is retargeted to the dialog itself, so compare coordinates
  // against its box: clicks on the modal, including its padding, never close it.
  function backdropClick(event: MouseEvent<HTMLDialogElement>) {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
    if (!inside) onClose()
  }
  return <dialog ref={ref} className="modal" onClose={onClose} onClick={backdropClick} aria-labelledby={titleId}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} aria-hidden="true" /></button></div>{children}
  </dialog>
}
function App() {
  const { attachPreview, canCancelExport, cancelExportJob, ...studio } = useStudio()
  const { status, settings: s } = studio
  const [openSection, setOpenSection] = useState<string | null>(null)
  const [discardTarget, setDiscardTarget] = useState<Session | null>(null)
  const [mobileSettings, setMobileSettings] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const settingsContainer = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const live = ['ready', 'countdown', 'starting', 'recording', 'paused', 'stopping'].includes(status)
  const recording = status === 'recording' || status === 'paused'
  const reviewing = status === 'review' || status === 'exporting'
  const busy = ['choosing', 'starting', 'stopping'].includes(status)
  const statusText = status === 'recording' ? 'Recording' : status === 'paused' ? 'Paused' : reviewing ? 'Review' : status === 'ready' ? 'Ready' : status === 'countdown' ? 'Starting' : 'Not recording'
  const changeSection = (section: string | null) => { setOpenSection(section); if (section === 'export') studio.probeExport() }
  function revealSettings() {
    setMobileSettings(true)
    if (window.matchMedia('(max-width: 800px)').matches) requestAnimationFrame(() => {
      settingsContainer.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
    })
  }
  const selectSection = (section: string) => { changeSection(section); revealSettings() }
  function dragBubble(event: PointerEvent<HTMLDivElement>) {
    const canvas = studio.getCanvas()
    if (!dragging.current || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const size = Math.min(rect.width * s.cameraSize / 100, rect.height * .8)
    const x = (event.clientX - rect.left - size / 2) / Math.max(1, rect.width - size) * 100
    const y = (event.clientY - rect.top - size / 2) / Math.max(1, rect.height - size) * 100
    studio.update('cameraX', Math.max(0, Math.min(100, x)))
    studio.update('cameraY', Math.max(0, Math.min(100, y)))
  }
  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    const canvas = studio.getCanvas()
    if (!s.camera || !canvas || !live) return
    const rect = canvas.getBoundingClientRect()
    const size = Math.min(rect.width * s.cameraSize / 100, rect.height * .8)
    const x = rect.left + (rect.width - size) * s.cameraX / 100
    const y = rect.top + (rect.height - size) * s.cameraY / 100
    if (event.clientX < x || event.clientX > x + size || event.clientY < y || event.clientY > y + size) return
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
    dragBubble(event)
  }
  async function expand() {
    if (!frame.current) return
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await frame.current.requestFullscreen() }
    catch { studio.setNotice('Fullscreen preview isn’t available in this browser window.') }
  }
  return <div className="app-shell">
    <a href="#studio" className="skip-link">Skip to recording studio</a>
    <div className="workspace">
      <div ref={settingsContainer} className={`sidebar-wrap ${mobileSettings ? 'mobile-open' : ''}`}>
        <SettingsPanel studio={studio} openSection={openSection} setOpenSection={changeSection} onDiscard={setDiscardTarget} />
      </div>
      <main id="studio" className="main-studio">
        <button type="button" className="icon-button mobile-settings" onClick={() => { if (mobileSettings) setMobileSettings(false); else revealSettings() }} aria-expanded={mobileSettings} aria-label={mobileSettings ? 'Hide settings' : 'Show settings'}><Settings2 size={18} aria-hidden="true" /></button>
        <div className="stage">
          <div className="stage-frame">
            <div className="preview-frame" ref={frame}>
              <div className="screen-area">
                <div ref={attachPreview} className={`canvas-host ${live ? '' : 'is-hidden'} ${s.camera ? 'draggable-preview' : ''}`} role="img" aria-label="Live screen preview. Camera corner controls are available in Settings." onPointerDown={beginDrag} onPointerMove={dragBubble} onPointerUp={() => { dragging.current = false }} onPointerCancel={() => { dragging.current = false }} />
                {reviewing && studio.reviewUrl ? <video className="review-video" src={studio.reviewUrl} controls playsInline aria-label="Your recorded video" onError={() => studio.setError('The saved recording couldn’t be previewed. Try downloading the original WebM; interrupted recordings may have incomplete final frames.')} /> : null}
                {!live && !reviewing ? <div className="empty-preview">
                  <div className="capture-illustration" aria-hidden="true"><div className="illustration-screen"><span className="illustration-dot" /><span className="illustration-line" /><span className="illustration-line short" /><span className="illustration-cursor"><ArrowUpRight size={22} strokeWidth={2} /></span></div><span className="illustration-camera"><Circle size={15} fill="currentColor" strokeWidth={0} /></span></div>
                  <button className="primary-button choose-button" disabled={busy} onClick={() => void studio.chooseScreen()}>{status === 'choosing' ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <ScreenShare size={17} aria-hidden="true" />}{status === 'choosing' ? 'Choosing screen…' : 'Choose a screen'}</button>
                  <span className="capture-source-hint">Entire screen, window, or browser tab</span>
                </div> : null}
                {status === 'countdown' ? <div className="countdown-overlay"><span>{studio.countdown}</span><button className="secondary-button" onClick={studio.cancelCountdown}>Cancel countdown</button></div> : null}
                {status === 'exporting' ? <div className="export-overlay"><span className="export-icon"><ArrowDownToLine size={25} aria-hidden="true" /></span><h2>Exporting</h2><p>{Math.round(studio.progress * 100)}% {studio.progress === 1 ? '· finishing file' : '· keep this tab open'}</p><progress max={1} value={studio.progress} aria-label="Export progress" />{canCancelExport ? <button className="secondary-button" onClick={cancelExportJob}>Cancel export</button> : null}</div> : null}
                {status === 'paused' ? <div className="paused-pill"><Pause size={12} fill="currentColor" aria-hidden="true" />Recording paused</div> : null}
                {status === 'starting' || status === 'stopping' ? <div className="busy-overlay"><LoaderCircle size={24} className="spin" aria-hidden="true" /><span>{status === 'starting' ? 'Preparing recording…' : 'Saving recording…'}</span></div> : null}
                {!reviewing ? <button className="icon-button expand-button" onClick={() => void expand()} aria-label="Expand preview"><Expand size={15} aria-hidden="true" /></button> : null}
              </div>
              <div className="preview-bottom">
                {live ? <span className="source-label"><span className="source-dot" /><span title={studio.sourceName}>{studio.sourceName}</span></span>
                  : reviewing ? <span className="source-label">{studio.session?.width} × {studio.session?.height}<span className="small-divider" />{formatBytes(studio.bytes)}</span>
                  : <span className="source-label" />}
                {!reviewing ? <SetupChips studio={studio} setOpenSection={selectSection} /> : null}
              </div>
            </div>
            <div className="transport-bar">
              <div className="recording-time"><span className={`recording-indicator ${status === 'recording' ? 'active' : ''}`} /><div><strong>{formatTime(studio.seconds)}</strong><span>{statusText}</span></div></div>
              <div className="transport-actions">
                {reviewing ? <><button className="secondary-button" disabled={status === 'exporting'} onClick={studio.recordAgain}><RotateCcw size={15} aria-hidden="true" />Record again</button><button className="primary-button" disabled={status === 'exporting' || !studio.bytes} onClick={() => void studio.download()}><ArrowDownToLine size={16} aria-hidden="true" />Download video</button></> : recording ? <><button className="secondary-button" onClick={studio.pause}>{status === 'paused' ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}{status === 'paused' ? 'Resume' : 'Pause'}</button><button className="primary-button" onClick={studio.stop}><CircleStop size={16} aria-hidden="true" />Stop recording</button></> : <>{status === 'ready' ? <button className="secondary-button" onClick={() => void studio.chooseScreen()} disabled={studio.deviceBusy}><ScreenShare size={15} aria-hidden="true" />Change screen</button> : null}<button className="primary-button start-button" disabled={status !== 'ready' || studio.deviceBusy} onClick={() => void studio.start()}>{busy || studio.deviceBusy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Circle size={14} strokeWidth={2.5} aria-hidden="true" />}{studio.deviceBusy ? 'Preparing devices…' : 'Start recording'}</button></>}
              </div>
            </div>
          </div>
          {studio.error || studio.notice ? <div className={`message ${studio.error ? 'error-message' : ''}`} role="status" aria-live="polite" aria-atomic="true">
            {studio.error ? <CircleAlert size={16} aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}
            <span>{studio.error || studio.notice}{studio.error && reviewing ? <button className="text-button" disabled={status === 'exporting'} onClick={() => void studio.download(true)}>Download original WebM</button> : null}</span>
            <button className="icon-button" aria-label={studio.error ? 'Dismiss error' : 'Dismiss notice'} onClick={() => { studio.setError(''); studio.setNotice('') }}><X size={15} aria-hidden="true" /></button>
          </div> : null}
        </div>
      </main>
    </div>
    <Modal open={!!discardTarget} onClose={() => setDiscardTarget(null)} title="Discard this recording?">
      <p className="modal-description">This deletes the recovery copy from this browser. Make sure you’ve downloaded anything you want to keep. This can’t be undone.</p>
      <div className="modal-actions"><button className="secondary-button" onClick={() => setDiscardTarget(null)}>Keep recording</button><button className="primary-button" onClick={() => { if (discardTarget) void studio.discard(discardTarget); setDiscardTarget(null) }}>Discard recording</button></div>
    </Modal>
  </div>
}
export default App
