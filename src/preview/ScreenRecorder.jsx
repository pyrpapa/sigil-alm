import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Records the screen while a test is executed, so the recording can be attached to the
// run as evidence (SRS-050). Browsers always show their own picker before sharing (a
// privacy rule no page can skip), so Sigil asks for a whole screen: Chrome and Edge open
// the picker on "Entire screen", and if a single window or tab is picked anyway, Sigil
// stops and asks again, because a window recording can miss dialogs and other apps
// that are part of the test. Phone browsers can't record the screen, so the bar is hidden there.
// Chrome and Edge can also pop the timer out into a small always-on-top window
// (Document Picture-in-Picture), handy while testing in another app. Firefox can't yet.
const canPopOut = typeof window !== 'undefined' && 'documentPictureInPicture' in window

const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined'

export default function ScreenRecorder({ fileName, onRecorded }) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [message, setMessage] = useState('')
  const recorder = useRef(null)
  const stream = useRef(null)
  const timer = useRef(null)
  const baseTitle = useRef('')
  const [popout, setPopout] = useState(null) // the small always-on-top window, while open

  // Leaving the page stops the recording and releases the screen.
  useEffect(() => () => stopTracks(), [])

  function stopTracks() {
    clearInterval(timer.current)
    stream.current?.getTracks().forEach((t) => t.stop())
    if (baseTitle.current) document.title = baseTitle.current
    window.documentPictureInPicture?.window?.close()
  }

  async function popOut() {
    const pip = await window.documentPictureInPicture.requestWindow({ width: 260, height: 96 })
    pip.document.title = 'Sigil recording'
    pip.addEventListener('pagehide', () => setPopout(null))
    setPopout(pip)
  }

  // The elapsed time also goes in the tab title, so it stays visible while you work in
  // another window during the test (e.g. "● REC 02:15 · Sigil").
  function tick(startedAt) {
    const secs = Math.round((Date.now() - startedAt) / 1000)
    setSeconds(secs)
    document.title = `● REC ${formatClock(secs)} · ${baseTitle.current}`
  }

  async function start() {
    setMessage('')
    try {
      stream.current = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 15 }, // hint: open the picker on whole screens
        audio: false,
        monitorTypeSurfaces: 'include',
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      })
    } catch {
      setMessage('Screen recording was not started.')
      return
    }

    const track = stream.current.getVideoTracks()[0]
    const surface = track.getSettings().displaySurface // 'monitor' | 'window' | 'browser' (undefined in older browsers)
    if (surface && surface !== 'monitor') {
      stopTracks()
      setMessage('That was a single window or tab. Select Record screen again and choose a whole screen (for example "Screen 1").')
      return
    }

    const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
    const chunks = []
    const rec = new MediaRecorder(stream.current, { mimeType: type })
    const startedAt = Date.now()
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    rec.onstop = () => {
      stopTracks()
      setRecording(false)
      const blob = new Blob(chunks, { type: 'video/webm' })
      const stamp = new Date(startedAt).toISOString().slice(11, 19).replaceAll(':', '')
      onRecorded({ name: `${fileName}-${stamp}.webm`, size: blob.size, kind: 'recording', url: URL.createObjectURL(blob) })
      setMessage('Recording attached to Evidence at the end of the run.')
    }
    // Stopping from the browser's own "Stop sharing" bar ends the recording too.
    track.addEventListener('ended', () => rec.state !== 'inactive' && rec.stop())
    rec.start(1000)
    recorder.current = rec
    baseTitle.current = document.title
    setRecording(true)
    tick(startedAt)
    timer.current = setInterval(() => tick(startedAt), 1000)
  }

  if (!supported) return null

  const clock = formatClock(seconds)

  return (
    <section className={`card recorder-bar${recording ? ' is-recording' : ''}`} aria-label="Screen recording">
      {recording ? (
        <>
          <div className="recorder-text">
            <span className="recording-dot" aria-hidden="true" />
            <strong>Recording your screen</strong>
            <span className="rec-clock" role="timer" aria-label={`Recording time ${clock}`}>
              {clock}
            </span>
          </div>
          <div className="actions">
            {canPopOut && !popout && (
              <button type="button" className="secondary small" onClick={popOut}>
                Pop out timer
              </button>
            )}
            <button type="button" className="record-button stop" onClick={() => recorder.current?.stop()}>
              ■ Stop recording
            </button>
          </div>
          {popout && createPortal(<MiniTimer clock={clock} onStop={() => recorder.current?.stop()} />, popout.document.body)}
        </>
      ) : (
        <>
          <div className="recorder-text">
            <strong>Record this run as evidence</strong>
            <span className="muted small">
              Start before step 1. When your browser asks, choose a whole screen (for example "Screen 1"), not a window.
            </span>
            {message && (
              <span className="small" role="alert">
                {message}
              </span>
            )}
          </div>
          <button type="button" className="record-button" onClick={start}>
            ● Record screen
          </button>
        </>
      )}
    </section>
  )
}

function formatClock(secs) {
  const h = Math.floor(secs / 3600)
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0')
  const ss = String(secs % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

// Contents of the pop-out window. Inline styles, because the page's stylesheet doesn't
// reach that separate window.
function MiniTimer({ clock, onStop }) {
  return (
    <div style={{ font: '600 15px system-ui, sans-serif', display: 'flex', alignItems: 'center', gap: 12, padding: 14, background: '#1c1f24', color: '#fff', height: '100vh', boxSizing: 'border-box', margin: -8 }}>
      <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#e5484d' }} />
      <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{clock}</span>
      <button type="button" onClick={onStop} style={{ marginLeft: 'auto', font: 'inherit', padding: '6px 12px', borderRadius: 6, border: 0, background: '#e5484d', color: '#fff', cursor: 'pointer' }}>
        Stop
      </button>
    </div>
  )
}
