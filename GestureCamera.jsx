/**
 * GestureCamera — MediaPipe hand gesture recognition component.
 * Renders a live camera feed with real-time gesture detection and
 * optional hand landmark overlay. Uses MediaPipe WASM (runs in browser).
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { gesture } from '../lib/gesture'
import { deviceWords, deviceProgressText, deviceFailureText } from '../lib/_device-words.js'

// Hand landmark connections for drawing skeleton overlay
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],       // thumb
  [0,5],[5,6],[6,7],[7,8],       // index
  [0,9],[9,10],[10,11],[11,12],  // middle
  [0,13],[13,14],[14,15],[15,16],// ring
  [0,17],[17,18],[18,19],[19,20],// pinky
  [5,9],[9,13],[13,17],          // palm
]

/**
 * @param {object} props
 * @param {'front'|'back'} [props.camera='front'] - Which camera to use
 * @param {number} [props.maxHands=2] - Maximum number of hands to detect
 * @param {number} [props.minConfidence=0.5] - Minimum detection confidence (0-1)
 * @param {function} [props.onGesture] - Called with array of gestures: [{ name, confidence, handedness }]
 * @param {function} [props.onHands] - Called with array of hands: [{ landmarks, handedness }]
 * @param {function} [props.onPresence] - Called true when a hand appears, false (debounced) when it leaves
 * @param {boolean} [props.overlay=true] - Draw hand landmark skeleton on canvas
 * @param {boolean} [props.mirrored=true] - Mirror the camera feed (recommended for front camera)
 * @param {string} [props.className] - CSS class for the container
 * @param {object} [props.style] - Inline styles for the container
 */
export default function GestureCamera({
  camera = 'front',
  maxHands = 2,
  minConfidence = 0.5,
  onGesture,
  onHands,
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
  const callbacksRef = useRef({ onGesture, onHands, onPresence })
  const presentRef = useRef(null)
  const emptyFramesRef = useRef(0)

  const [status, setStatus] = useState('idle') // idle | loading | ready | error
  const [error, setError] = useState(null)
  const [statusText, setStatusText] = useState('Preparing…')
  const [retryCount, setRetryCount] = useState(0)

  // Keep callback refs up-to-date without restarting detector
  useEffect(() => {
    callbacksRef.current = { onGesture, onHands, onPresence }
  }, [onGesture, onHands, onPresence])

  // Draw hand landmarks on canvas
  const drawOverlay = useCallback((hands, videoEl, canvasEl) => {
    const ctx = canvasEl.getContext('2d')
    const w = videoEl.videoWidth
    const h = videoEl.videoHeight

    if (canvasEl.width !== w) canvasEl.width = w
    if (canvasEl.height !== h) canvasEl.height = h

    ctx.clearRect(0, 0, w, h)

    for (const hand of hands) {
      const pts = hand.landmarks

      // Draw connections
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.8)'
      ctx.lineWidth = 3
      for (const [a, b] of HAND_CONNECTIONS) {
        if (!pts[a] || !pts[b]) continue
        ctx.beginPath()
        ctx.moveTo(pts[a].x * w, pts[a].y * h)
        ctx.lineTo(pts[b].x * w, pts[b].y * h)
        ctx.stroke()
      }

      // Draw points
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      for (const pt of pts) {
        ctx.beginPath()
        ctx.arc(pt.x * w, pt.y * h, 4, 0, 2 * Math.PI)
        ctx.fill()
      }
    }
  }, [])

  // Start/stop detector on mount/unmount or when camera changes
  useEffect(() => {
    let cancelled = false

    async function init() {
      setStatus('loading')
      setError(null)

      try {
        const det = await gesture.start({
          camera, maxHands, minConfidence,
          onProgress: (text) => { if (!cancelled) setStatusText(text) },
        })

        if (cancelled) {
          det.stop()
          return
        }

        detectorRef.current = det

        // Attach the video element to our container
        const videoEl = det.video
        videoEl.style.width = '100%'
        videoEl.style.height = '100%'
        videoEl.style.objectFit = 'cover'
        videoEl.style.display = 'block'
        videoRef.current = videoEl

        if (containerRef.current) {
          const wrapper = containerRef.current.querySelector('[data-gesture-video]')
          if (wrapper) {
            wrapper.innerHTML = ''
            wrapper.appendChild(videoEl)
          }
        }

        setStatus('ready')

        // Wire up result callback
        det.onResult((result) => {
          if (cancelled) return

          const { onGesture: gCb, onHands: hCb, onPresence: pCb } = callbacksRef.current

          if (gCb && result.gestures.length > 0) {
            gCb(result.gestures)
          }

          if (hCb && result.hands.length > 0) {
            hCb(result.hands)
          }

          // Presence (hands in frame), debounced so a dropped frame doesn't flicker
          if (result.hands.length > 0) {
            emptyFramesRef.current = 0
            if (presentRef.current !== true) { presentRef.current = true; if (pCb) pCb(true) }
          } else {
            emptyFramesRef.current += 1
            if (emptyFramesRef.current >= 6 && presentRef.current !== false) {
              presentRef.current = false
              if (pCb) pCb(false)
            }
          }

          // Draw overlay
          if (overlay && canvasRef.current && videoRef.current) {
            drawOverlay(result.hands, videoRef.current, canvasRef.current)
          }
        })
      } catch (err) {
        if (cancelled) return
        console.error('[GestureCamera] init error:', err)
        setStatus('error')
        setError(err.message || 'Failed to start gesture detection')
      }
    }

    init()

    return () => {
      cancelled = true
      if (detectorRef.current) {
        detectorRef.current.stop()
        detectorRef.current = null
      }
    }
  }, [camera, maxHands, minConfidence, retryCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const shouldMirror = mirrored && camera === 'front'

  const containerStyle = {
    position: 'relative',
    width: '100%',
    height: '300px',
    borderRadius: '12px',
    overflow: 'hidden',
    backgroundColor: '#111',
    ...style,
  }

  const mediaStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    transform: shouldMirror ? 'scaleX(-1)' : 'none',
  }

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      {/* Video container */}
      <div data-gesture-video style={mediaStyle} />

      {/* Canvas overlay for hand skeleton */}
      {overlay && (
        <canvas
          ref={canvasRef}
          style={{
            ...mediaStyle,
            pointerEvents: 'none',
            objectFit: 'cover',
          }}
        />
      )}

      {/* Loading state */}
      {status === 'loading' && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.7)',
          color: '#fff',
          gap: '12px',
          zIndex: 10,
        }}>
          <div style={{
            width: '32px',
            height: '32px',
            border: '3px solid rgba(255,255,255,0.3)',
            borderTopColor: '#fff',
            borderRadius: '50%',
            animation: 'gesture-spin 0.8s linear infinite',
          }} />
          <span style={{ fontSize: '14px', opacity: 0.9 }}>{deviceProgressText(statusText)}</span>
          <style>{`@keyframes gesture-spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}

      {/* Error state */}
      {status === 'error' && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.8)',
          color: '#fff',
          padding: '20px',
          textAlign: 'center',
          zIndex: 10,
        }}>
          <span style={{ fontSize: '24px', marginBottom: '8px' }}>&#128247;</span>
          <span style={{ fontSize: '14px', opacity: 0.9, marginBottom: '16px' }}>{deviceFailureText(error)}</span>
          <button
            onClick={() => setRetryCount((c) => c + 1)}
            style={{
              padding: '8px 20px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.3)',
              backgroundColor: 'rgba(255,255,255,0.15)',
              color: '#fff',
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            {deviceWords().retry}
          </button>
        </div>
      )}
    </div>
  )
}
