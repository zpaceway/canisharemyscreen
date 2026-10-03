import { useEffect, useState } from 'react'
import { AudioLines, Camera, ChevronDown, HardDrive, Monitor, RotateCcw, Video, Volume2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Settings } from '../lib/settings'
import { defaults, formatBytes, formatTime } from '../lib/settings'
import type { Studio } from '../hooks/useStudio'
import type { Session } from '../lib/storage'

export function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <label className="toggle-row"><span>{label}</span><input className="sr-only" type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} /><span className="switch" aria-hidden="true"><span /></span></label>
}
function Range({ label, value, onChange, min = 0, max = 100, suffix = '%', disabled = false }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; suffix?: string; disabled?: boolean }) {
  return <label className="range-label"><span>{label}<span className="control-value">{value}{suffix}</span></span><input type="range" aria-label={label} min={min} max={max} value={value} disabled={disabled} onChange={e => onChange(Number(e.target.value))} /></label>
}
function Select({ label, value, onChange, children, disabled = false }: { label: string; value: string | number; onChange: (v: string) => void; children: ReactNode; disabled?: boolean }) {
  return <label className="select-label"><span>{label}</span><span className="select-wrap"><select aria-label={label} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>{children}</select><ChevronDown size={13} aria-hidden="true" /></span></label>
}
function Section({ title, hint, icon: Icon, children, id, openSection, setOpenSection }: { title: string; hint: string; icon: LucideIcon; children: ReactNode; id: string; openSection: string | null; setOpenSection: (id: string | null) => void }) {
  const open = openSection === id
  return <section className={`settings-section ${open ? 'is-open' : ''}`}>
    <button className="section-trigger" onClick={() => setOpenSection(open ? null : id)} aria-expanded={open} aria-controls={`settings-${id}`}>
      <span className="section-icon"><Icon size={18} strokeWidth={1.6} aria-hidden="true" /></span>
      <span className="section-label"><span>{title}</span><span>{hint}</span></span><ChevronDown size={15} className="section-chevron" aria-hidden="true" />
    </button>
    <div id={`settings-${id}`} hidden={!open} className="section-content">{children}</div>
  </section>
}
function MicMeter({ studio }: { studio: Studio }) {
  const [level, setLevel] = useState(0)
  const { getMeter } = studio
  useEffect(() => { const interval = setInterval(() => setLevel(getMeter()), 100); return () => clearInterval(interval) }, [getMeter])
  return <div className="mic-meter" aria-label="Microphone input level"><span>Input level</span><div>{Array.from({ length: 16 }, (_, i) => <i key={i} className={i / 16 < level ? 'lit' : ''} />)}</div></div>
}
export function SettingsPanel({ studio, openSection, setOpenSection, onDiscard }: { studio: Studio; openSection: string | null; setOpenSection: (id: string | null) => void; onDiscard: (session: Session) => void }) {
  const { settings: s, update, status } = studio
  const live = ['countdown', 'starting', 'recording', 'paused', 'stopping'].includes(status)
  const devicesLocked = live || status === 'choosing' || studio.deviceBusy
  const reviewing = status === 'review' || status === 'exporting'
  const cameras = studio.devices.filter(d => d.kind === 'videoinput')
  const mics = studio.devices.filter(d => d.kind === 'audioinput')
  const deviceOptions = (list: MediaDeviceInfo[], label: string) => list.filter(d => d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)
  const audioHint = s.mic && s.systemAudio ? 'Mic + screen' : s.mic ? 'Mic' : s.systemAudio ? 'Screen' : 'Off'
  const changed = (Object.keys(defaults) as (keyof Settings)[]).some(key => s[key] !== defaults[key])
  const estimatedBytes = studio.session ? Math.min(studio.session.bytes, studio.session.seconds * (s.compression === 'small' ? 1.628e6 : 3.628e6) / 8) : 0
  return <aside className="sidebar" aria-label="Recording settings">
    <div className="sidebar-brand">
      <span className="brand-mark" aria-hidden="true"><Monitor size={17} strokeWidth={1.8} /><span /></span>
      <span className="brand-name" translate="no">can i share my screen<span className="brand-question">?</span></span>
    </div>
    <div className="settings-list">
      <Section openSection={openSection} setOpenSection={setOpenSection} id="capture" title="Capture" hint={`${s.resolution ? `${s.resolution}p` : 'Source'} · ${s.fps} fps`} icon={Monitor}>
        <Select label="Resolution" value={s.resolution} disabled={live || reviewing} onChange={v => update('resolution', Number(v))}>
          {[720, 1080, 1440, 2160].map(n => <option key={n} value={n}>{n === 2160 ? '4K · 2160p' : `${n}p`}</option>)}<option value={0}>Source resolution</option>
        </Select>
        <Select label="Frame rate" value={s.fps} disabled={live || reviewing} onChange={v => update('fps', Number(v))}>{[24, 30, 60].map(n => <option key={n} value={n}>{n} fps</option>)}</Select>
        <Select label="Recording quality" value={s.quality} disabled={live || reviewing} onChange={v => update('quality', v as Settings['quality'])}><option value="low">Light · 3 Mbps</option><option value="balanced">Balanced · 6 Mbps</option><option value="high">High · 12 Mbps</option></Select>
        <Toggle label="3-second countdown" checked={s.countdown} disabled={live || reviewing} onChange={v => update('countdown', v)} />
        <details className="advanced"><summary>Advanced bitrate</summary><Range label="Bitrate" value={s.bitrate} max={50} suffix={s.bitrate ? ' Mbps' : ' · Auto'} disabled={live || reviewing} onChange={v => update('bitrate', v)} /></details>
        <p className="field-note">Resolution is capped at your source. Frame rate may vary with device performance.</p>
      </Section>
      <Section openSection={openSection} setOpenSection={setOpenSection} id="camera" title="Camera" hint={s.camera ? 'On' : 'Off'} icon={Camera}>
        <Toggle label="Camera bubble" checked={s.camera} disabled={devicesLocked || reviewing} onChange={v => update('camera', v)} />
        {s.camera ? <>
          <Select label="Camera device" value={s.cameraDevice} disabled={devicesLocked || reviewing} onChange={v => update('cameraDevice', v)}><option value="">Front / default camera</option>{deviceOptions(cameras, 'Camera')}</Select>
          <Range label="Bubble size" min={10} max={35} value={s.cameraSize} disabled={reviewing} onChange={v => update('cameraSize', v)} />
          <Range label="Roundness" value={s.roundness} disabled={reviewing} onChange={v => update('roundness', v)} />
          <span className="field-title">Position</span>
          <div className="position-grid">{[{ x: 4, y: 6, label: 'Top left' }, { x: 96, y: 6, label: 'Top right' }, { x: 4, y: 94, label: 'Bottom left' }, { x: 96, y: 94, label: 'Bottom right' }].map(p => <button key={p.label} disabled={reviewing} aria-label={p.label} aria-pressed={s.cameraX === p.x && s.cameraY === p.y} onClick={() => { update('cameraX', p.x); update('cameraY', p.y) }}><span style={{ left: `${p.x < 50 ? 20 : 70}%`, top: `${p.y < 50 ? 20 : 65}%` }} /></button>)}</div>
          <Toggle label="Mirror camera" checked={s.mirror} disabled={reviewing} onChange={v => update('mirror', v)} />
          <Toggle label="Border" checked={s.border} disabled={reviewing} onChange={v => update('border', v)} />
          <p className="field-note">Drag the bubble in the preview or use a corner preset. Applies to the recording.</p>
        </> : <p className="field-note">Camera access is requested after you choose a screen.</p>}
      </Section>
      <Section openSection={openSection} setOpenSection={setOpenSection} id="audio" title="Audio" hint={audioHint} icon={AudioLines}>
        <Toggle label="Microphone" checked={s.mic} disabled={devicesLocked || reviewing} onChange={v => update('mic', v)} />
        {s.mic ? <>
          <Select label="Microphone device" value={s.micDevice} disabled={devicesLocked || reviewing} onChange={v => update('micDevice', v)}><option value="">Default microphone</option>{deviceOptions(mics, 'Microphone')}</Select>
          <Range label="Mic volume" value={s.micVolume} disabled={reviewing} onChange={v => update('micVolume', v)} />
          <MicMeter studio={studio} />
          <Toggle label="Noise suppression" checked={s.noiseSuppression} disabled={devicesLocked || reviewing} onChange={v => update('noiseSuppression', v)} />
          <Toggle label="Echo cancellation" checked={s.echoCancellation} disabled={devicesLocked || reviewing} onChange={v => update('echoCancellation', v)} />
        </> : null}
        <Toggle label="Screen / system audio" checked={s.systemAudio} disabled={live || reviewing || status === 'choosing'} onChange={v => update('systemAudio', v)} />
        {s.systemAudio ? <Range label="Screen audio volume" value={s.systemVolume} disabled={reviewing} onChange={v => update('systemVolume', v)} /> : null}
        <p className="field-note">Select a supported source and enable “Share audio” in the browser picker.{status === 'ready' ? ' Choose your screen again after changing this toggle.' : ''}</p>
      </Section>
      <Section openSection={openSection} setOpenSection={setOpenSection} id="export" title="Export" hint={`${s.format.toUpperCase()} · ${s.compression === 'original' ? 'Original' : s.compression === 'small' ? 'Small file' : 'Balanced'}`} icon={Video}>
        <Select label="Video format" value={s.format} disabled={status === 'exporting'} onChange={v => update('format', v as Settings['format'])}><option value="webm">WebM</option><option value="mp4" disabled={studio.exportSupport?.mp4 === false}>MP4{studio.exportSupport?.mp4 === false ? ' · Not supported' : ''}</option></Select>
        <Select label="Compression" value={s.compression} disabled={status === 'exporting'} onChange={v => update('compression', v as Settings['compression'])}><option value="original">Original quality</option><option value="balanced" disabled={studio.exportSupport?.[s.format] === false}>Balanced · up to 1080p</option><option value="small" disabled={studio.exportSupport?.[s.format] === false}>Small file · up to 720p</option></Select>
        {studio.session ? <div className="size-estimate"><span>{s.compression === 'original' ? 'Recorded size' : 'Estimated size'}</span><strong>{s.compression === 'original' ? formatBytes(studio.session.bytes) : `~${formatBytes(estimatedBytes)}`}</strong></div> : null}
        <p className="field-note">Compression re-encodes your recording. Final size varies. MP4 uses streaming fragments; playback and seeking depend on the player.</p>
      </Section>
    </div>
    <div className="sidebar-bottom">
      {changed ? <button className="restore-button" onClick={studio.resetSettings} disabled={live || reviewing || status === 'choosing'}><RotateCcw size={13} aria-hidden="true" />Restore defaults</button> : null}
      {studio.recoveries.length ? <div className="recovery-list"><h3>Saved sessions <span>{studio.recoveries.length}</span></h3>{studio.recoveries.map(saved => <div className="recovery-item" key={saved.id}><button onClick={() => void studio.recover(saved)} disabled={!['idle', 'review'].includes(status)}><HardDrive size={15} aria-hidden="true" /><span><strong>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(saved.created)}</strong><span>{formatTime(saved.seconds)} / {formatBytes(saved.bytes)}</span></span></button><button className="icon-button" disabled={live || status === 'exporting'} onClick={() => onDiscard(saved)} aria-label="Discard saved recording"><X size={14} aria-hidden="true" /></button></div>)}</div> : null}
    </div>
  </aside>
}
export function SetupChips({ studio, setOpenSection }: { studio: Studio; setOpenSection: (id: string) => void }) {
  return <div className="setup-chips"><button onClick={() => setOpenSection('camera')}><Camera size={14} aria-hidden="true" />Camera {studio.settings.camera ? 'on' : 'off'}</button><button onClick={() => setOpenSection('audio')}><Volume2 size={14} aria-hidden="true" />{studio.settings.mic || studio.settings.systemAudio ? 'Audio on' : 'Audio off'}</button></div>
}
