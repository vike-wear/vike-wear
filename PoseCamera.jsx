/**
 * PoseCamera — MediaPipe pose detection component.
 * Renders a live camera feed with real-time body pose detection and
 * optional skeleton overlay. Uses MediaPipe WASM (runs in browser).
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { pose } from '../lib/pose'
import { deviceWords, deviceProgressText, deviceFailureText } from '../lib/_device-words.js'

// Skeleton connections for overlay
const POSE_CONNECTIONS = pose.connections

// Color groups for overlay
const TORSO_INDICES = [[11,12],[11,23],[12,24],[23,24]]
const LEFT_ARM = [[11,13],[13,15]]
const RIGHT_ARM = [[12,14],[14,16]]
const LEFT_LEG = [[23,25],[25,27],[27,29],[27,31]]
const RIGHT_LEG = [[24,26],[26,28],[28,30],[28,32]]

/**
 * @param {object} props
 * @param {'front'|'back'} [props.camera='front'] - Which camera to use
 * @param {number} [props.maxPoses=1] - Maximum poses to detect
 * @param {number} [props.minConfidence=0.5] - Minimum detection confidence
 * @param {function} [props.onPose] - Called with array of detected poses (only when ≥1 present)
 * @param {function} [props.onPresence] - Called true when a body appears, false (debounced) when it leaves
 * @param {boolean} [props.overlay=true] - Draw body skeleton on canvas
 * @param {boolean} [props.mirrored=true] - Mirror the camera feed
 * @param {string} [props.className] - CSS class for the container
 * @param {object} [props.style] - Inline styles for the container
 */
export default function PoseCamera({
  camera = 'front',
  maxPoses = 1,
  minConfidence = 0.5,
  onPose,
  onPresence,
  overlay = true,
  mirrored = true,
  className = '',
  style = {},
}) {
  const containerRef = useRef(null)
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const detectorRef = useRef(null)
  const callbackRef = useRef(onPose)
  const presenceCbRef = useRef(onPresence)
  const presentRef = useRef(null)
  const emptyFramesRef = useRef(0)

  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)
  const [statusText, setStatusText] = useState('Preparing…')
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => { callbackRef.current = onPose }, [onPose])
  useEffect(() => { presenceCbRef.current = onPresence }, [onPresence])

  const drawOverlay = useCallback((poses, vw, vh, ctx) => {
    function isConn(pair, list) {
      return list.some(([a,b]) => a === pair[0] && b === pair[1])
    }

    for (const p of poses) {
      const pts = p.raw

      // Draw connections with color coding
      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = pts[a]
        const pb = pts[b]
        if (!pa || !pb || pa.visibility < 0.3 || pb.visibility < 0.3) continue

        const pair = [a, b]
        if (isConn(pair, TORSO_INDICES)) ctx.strokeStyle = 'rgba(168, 162, 158, 0.7)'
        else if (isConn(pair, LEFT_ARM)) ctx.strokeStyle = 'rgba(71, 85, 105, 0.8)'
        else if (isConn(pair, RIGHT_ARM)) ctx.strokeStyle = 'rgba(34, 197, 94, 0.8)'
        else if (isConn(pair, LEFT_LEG)) ctx.strokeStyle = 'rgba(71, 85, 105, 0.8)'
        else if (isConn(pair, RIGHT_LEG)) ctx.strokeStyle = 'rgba(34, 197, 94, 0.8)'
        else ctx.strokeStyle = 'rgba(168, 162, 158, 0.5)'

        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(pa.x * vw, pa.y * vh)
        ctx.lineTo(pb.x * vw, pb.y * vh)
        ctx.stroke()
      }

      // Draw points
      for (const pt of pts) {
        if (pt.visibility < 0.3) continue
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.beginPath()
        ctx.arc(pt.x * vw, pt.y * vh, 5, 0, 2 * Math.PI)
        ctx.fill()
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function init() {
      setStatus('loading')
      setError(null)

      try {
        const det = await pose.start({
          camera, maxPoses, minConfidence,
          onProgress: (text) => { if (!cancelled) setStatusText(text) },
        })

        if (cancelled) { det.stop(); return }

        detectorRef.current = det
        const videoEl = det.video
        videoEl.style.width = '100%'
        videoEl.style.height = '100%'
        videoEl.style.objectFit = 'cover'
        videoEl.style.display = 'block'
        videoRef.current = videoEl

        if (containerRef.current) {
          const wrapper = containerRef.current.querySelector('[data-pose-video]')
          if (wrapper) { wrapper.innerHTML = ''; wrapper.appendChild(videoEl) }
        }

        setStatus('ready')

        det.onResult((result) => {
          if (cancelled) return
          if (result.poses.length > 0) {
            emptyFramesRef.current = 0
            if (presentRef.current !== true) { presentRef.current = true; if (presenceCbRef.current) presenceCbRef.current(true) }
            if (callbackRef.current) callbackRef.current(result.poses)
          } else {
            emptyFramesRef.current += 1
            // fire absence once after a short gap (≈6 frames) so a single dropped frame doesn't flicker
            if (emptyFramesRef.current >= 6 && presentRef.current !== false) {
              presentRef.current = false
              if (presenceCbRef.current) presenceCbRef.current(false)
            }
          }
          if (overlay && canvasRef.current && videoRef.current) {
            const vw = videoRef.current.videoWidth
            const vh = videoRef.current.videoHeight
            const canvas = canvasRef.current
            if (canvas.width !== vw) canvas.width = vw
            if (canvas.height !== vh) canvas.height = vh
            const ctx = canvas.getContext('2d')
            ctx.clearRect(0, 0, vw, vh)
            drawOverlay(result.poses, vw, vh, ctx)
          }
        })
      } catch (err) {
        if (cancelled) return
        console.error('[PoseCamera] init error:', err)
        setStatus('error')
        setError(err.message || 'Failed to start pose detection')
      }
    }

    init()
    return () => {
      cancelled = true
      if (detectorRef.current) { detectorRef.current.stop(); detectorRef.current = null }
    }
  }, [camera, maxPoses, minConfidence, retryCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const shouldMirror = mirrored && camera === 'front'

  const containerStyle = {
    position: 'relative', width: '100%', height: '300px',
    borderRadius: '12px', overflow: 'hidden', backgroundColor: '#111',
    ...style,
  }

  const mediaStyle = {
    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
    transform: shouldMirror ? 'scaleX(-1)' : 'none',
  }

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      <div data-pose-video style={mediaStyle} />
      {overlay && (
        <canvas ref={canvasRef} style={{ ...mediaStyle, pointerEvents: 'none', objectFit: 'cover' }} />
      )}
      {status === 'loading' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.7)', color: '#fff', gap: '12px', zIndex: 10,
        }}>
          <div style={{
            width: '32px', height: '32px', border: '3px solid rgba(255,255,255,0.3)',
            borderTopColor: '#fff', borderRadius: '50%',
            animation: 'pose-spin 0.8s linear infinite',
          }} />
          <span style={{ fontSize: '14px', opacity: 0.9 }}>{deviceProgressText(statusText)}</span>
          <style>{`@keyframes pose-spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}
      {status === 'error' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.8)', color: '#fff', padding: '20px',
          textAlign: 'center', zIndex: 10,
        }}>
          <span style={{ fontSize: '24px', marginBottom: '8px' }}>&#128247;</span>
          <span style={{ fontSize: '14px', opacity: 0.9, marginBottom: '16px' }}>{deviceFailureText(error)}</span>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            style={{
              padding: '8px 20px', borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.3)',
              backgroundColor: 'rgba(255,255,255,0.15)', color: '#fff',
              fontSize: '14px', cursor: 'pointer',
            }}
          >{deviceWords().retry}</button>
        </div>
      )}
    </div>
  )
}
