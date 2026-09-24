import { useEffect, useRef, useState, useCallback } from 'react'
import init, { greet, process_frame, dewarp_quad, snap_fiducial_corner } from './pkg/cv_engine'
import './App.css'

interface Point2D {
  x: number
  y: number
}

interface FrameAnalysis {
  width: number
  height: number
  avg_brightness: number
  elapsed_ms: number
}

const STORAGE_KEY = 'jigsaw_calibration_corners_v1'

const DEFAULT_CORNERS: [Point2D, Point2D, Point2D, Point2D] = [
  { x: 120, y: 40 },
  { x: 520, y: 40 },
  { x: 520, y: 320 },
  { x: 120, y: 320 },
]

function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [stats, setStats] = useState<FrameAnalysis | null>(null)
  const [autoDewarp, setAutoDewarp] = useState(true)
  const [snappedIndex, setSnappedIndex] = useState<number | null>(null)

  // 1. LocalStorage Persistence for Corner Coordinates
  const [corners, setCorners] = useState<[Point2D, Point2D, Point2D, Point2D]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length === 4) {
          return parsed as [Point2D, Point2D, Point2D, Point2D]
        }
      }
    } catch (e) {
      console.warn('Failed to load saved corners from localStorage:', e)
    }
    return DEFAULT_CORNERS
  })

  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const dewarpedCanvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameIdRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(performance.now())
  const frameCountRef = useRef<number>(0)
  const latestPixelsRef = useRef<{ bytes: Uint8Array; w: number; h: number } | null>(null)

  // Save corners to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(corners))
    } catch {}
  }, [corners])

  // Initialize WASM Engine
  useEffect(() => {
    init()
      .then(() => {
        setWasmReady(true)
        greet('Puzzle Master')
      })
      .catch((err) => {
        console.error('Failed to init WASM:', err)
        setCameraError('Failed to initialize WebAssembly engine.')
      })
  }, [])

  // 2. Camera Resolution Upgrade to 1080p Full HD (ideal: 1920x1080)
  const startCamera = async () => {
    try {
      setCameraError(null)
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
        },
        audio: false,
      })

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        setIsCameraActive(true)
      }
    } catch (err: any) {
      console.warn('1080p unavailable, attempting standard fallback:', err)
      try {
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (videoRef.current) {
          videoRef.current.srcObject = fallbackStream
          await videoRef.current.play()
          setIsCameraActive(true)
        }
      } catch (fallbackErr: any) {
        console.error('Camera fallback failed:', fallbackErr)
        setCameraError(fallbackErr.message || 'Permission denied or no camera found.')
      }
    }
  }

  const stopCamera = () => {
    if (animFrameIdRef.current) {
      cancelAnimationFrame(animFrameIdRef.current)
      animFrameIdRef.current = null
    }

    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream
      stream.getTracks().forEach((track) => track.stop())
      videoRef.current.srcObject = null
    }
    setIsCameraActive(false)
    setStats(null)
    latestPixelsRef.current = null
  }

  // Draw HUD / AR Quad overlay
  const drawOverlay = (w: number, h: number, pts: [Point2D, Point2D, Point2D, Point2D]) => {
    const overlay = overlayCanvasRef.current
    if (!overlay) return
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w
      overlay.height = h
    }
    const ctx = overlay.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, w, h)

    // Quad boundary lines
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    ctx.lineTo(pts[1].x, pts[1].y)
    ctx.lineTo(pts[2].x, pts[2].y)
    ctx.lineTo(pts[3].x, pts[3].y)
    ctx.closePath()
    ctx.strokeStyle = '#58a6ff'
    ctx.lineWidth = 2.5
    ctx.fillStyle = 'rgba(88, 166, 255, 0.08)'
    ctx.fill()
    ctx.stroke()

    // Corner anchor points with sub-pixel snapping indicators
    const labels = ['TL (0)', 'TR (1)', 'BR (2)', 'BL (3)']
    pts.forEach((pt, i) => {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2)
      ctx.fillStyle = i === draggingIdx ? '#ffd33d' : i === snappedIndex ? '#3fb950' : '#58a6ff'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()

      // Target reticle
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 14, 0, Math.PI * 2)
      ctx.strokeStyle = i === draggingIdx ? 'rgba(255, 211, 61, 0.5)' : 'rgba(88, 166, 255, 0.3)'
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.font = '10px monospace'
      ctx.fillText(labels[i], pt.x + 16, pt.y + 4)
    })
  }

  // Processing Loop: Video -> Canvas -> Rust WASM Dewarp
  const processLoop = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const dewarpedCanvas = dewarpedCanvasRef.current

    if (video && canvas && video.readyState >= 2 && wasmReady) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        const targetW = 640
        const targetH = Math.round((video.videoHeight / video.videoWidth) * targetW) || 360

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW
          canvas.height = targetH
        }

        ctx.drawImage(video, 0, 0, targetW, targetH)
        const imgData = ctx.getImageData(0, 0, targetW, targetH)

        try {
          const rawBytes = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength)
          latestPixelsRef.current = { bytes: rawBytes, w: targetW, h: targetH }

          const analysis: FrameAnalysis = process_frame(rawBytes, targetW, targetH)
          setStats(analysis)

          // Dewarp using current 4-corners into a crisp 384x384 orthographic macro view
          if (autoDewarp && dewarpedCanvas) {
            const dstW = 384
            const dstH = 384
            if (dewarpedCanvas.width !== dstW || dewarpedCanvas.height !== dstH) {
              dewarpedCanvas.width = dstW
              dewarpedCanvas.height = dstH
            }

            const dewarpedBytes: Uint8Array = dewarp_quad(
              rawBytes,
              targetW,
              targetH,
              corners[0].x, corners[0].y,
              corners[1].x, corners[1].y,
              corners[2].x, corners[2].y,
              corners[3].x, corners[3].y,
              dstW,
              dstH
            )

            const dCtx = dewarpedCanvas.getContext('2d')
            if (dCtx) {
              const dewarpedImageData = dCtx.createImageData(dstW, dstH)
              dewarpedImageData.data.set(dewarpedBytes)
              dCtx.putImageData(dewarpedImageData, 0, 0)
            }
          }
        } catch (e) {
          console.error('Rust compute error:', e)
        }

        drawOverlay(targetW, targetH, corners)

        // Calculate Frontend FPS
        frameCountRef.current += 1
        const now = performance.now()
        if (now - lastTimeRef.current >= 500) {
          setFps(Math.round((frameCountRef.current * 1000) / (now - lastTimeRef.current)))
          frameCountRef.current = 0
          lastTimeRef.current = now
        }
      }
    }

    animFrameIdRef.current = requestAnimationFrame(processLoop)
  }, [wasmReady, corners, autoDewarp, draggingIdx, snappedIndex])

  useEffect(() => {
    if (isCameraActive && wasmReady) {
      animFrameIdRef.current = requestAnimationFrame(processLoop)
    }
    return () => {
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current)
      }
    }
  }, [isCameraActive, wasmReady, processLoop])

  // Pointer / Touch / Mouse drag handling with Sub-Pixel Auto-Snap
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = 640 / rect.width
    const scaleY = 360 / rect.height
    const mx = (e.clientX - rect.left) * scaleX
    const my = (e.clientY - rect.top) * scaleY

    let closest = -1
    let minDist = 45
    corners.forEach((pt, i) => {
      const d = Math.hypot(pt.x - mx, pt.y - my)
      if (d < minDist) {
        minDist = d
        closest = i
      }
    })

    if (closest !== -1) {
      setDraggingIdx(closest)
      setSnappedIndex(null)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx === null) return
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = 640 / rect.width
    const scaleY = 360 / rect.height
    const mx = Math.max(0, Math.min(640, (e.clientX - rect.left) * scaleX))
    const my = Math.max(0, Math.min(360, (e.clientY - rect.top) * scaleY))

    setCorners((prev) => {
      const next = [...prev] as [Point2D, Point2D, Point2D, Point2D]
      next[draggingIdx] = { x: mx, y: my }
      return next
    })
  }

  // 3. Auto-Fiducial Snapping in Rust on Pointer Release
  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx !== null) {
      const idx = draggingIdx
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {}
      setDraggingIdx(null)

      // Snap to exact sub-pixel concentric ring center in Rust
      if (latestPixelsRef.current && wasmReady) {
        const { bytes, w, h } = latestPixelsRef.current
        const currentPt = corners[idx]
        const snapped = snap_fiducial_corner(bytes, w, h, currentPt.x, currentPt.y, 28)
        if (snapped && snapped.length >= 2) {
          const sx = snapped[0]
          const sy = snapped[1]
          // If within reasonable snap range (< 18px delta), lock to center!
          if (Math.hypot(sx - currentPt.x, sy - currentPt.y) < 18) {
            setCorners((prev) => {
              const next = [...prev] as [Point2D, Point2D, Point2D, Point2D]
              next[idx] = { x: sx, y: sy }
              return next
            })
            setSnappedIndex(idx)
            setTimeout(() => setSnappedIndex(null), 1200)
          }
        }
      }
    }
  }

  const handleResetCorners = () => {
    setCorners(DEFAULT_CORNERS)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {}
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-title">
          <h1>🧩 Jigsaw Solver</h1>
          <span className="badge">Pillar 1: Calibration Engine</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Status: {wasmReady ? '⚡ WASM Ready' : '⏳ Initializing...'}
        </div>
      </header>

      <div className="main-content">
        <section className="viewport-panel">
          <div className="panel-header">
            <span>Camera Feed & Optical Mat Overlay</span>
            <span>{isCameraActive ? `🟢 1080p Stream (${fps} Live FPS)` : '⚪ Standby'}</span>
          </div>

          <div className="video-container">
            <video
              ref={videoRef}
              playsInline
              muted
              className="camera-video"
              style={{ display: isCameraActive ? 'block' : 'none' }}
            />
            <canvas ref={canvasRef} className="hidden-canvas" />
            {isCameraActive && (
              <canvas
                ref={overlayCanvasRef}
                className="overlay-canvas"
                style={{ cursor: draggingIdx !== null ? 'grabbing' : 'crosshair' }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
            )}

            {!isCameraActive && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                <p>Camera is currently inactive.</p>
                <button className="primary" onClick={startCamera} disabled={!wasmReady}>
                  Enable Camera
                </button>
              </div>
            )}
          </div>

          {isCameraActive && (
            <div className="controls-bar">
              <button onClick={stopCamera}>Stop Camera</button>
              <button
                onClick={() => setAutoDewarp(!autoDewarp)}
                style={{ borderColor: autoDewarp ? '#3fb950' : '#30363d' }}
              >
                {autoDewarp ? '✓ Live Dewarp Active' : 'Enable Dewarp'}
              </button>
              <button onClick={handleResetCorners}>Reset Calibration Corners</button>
              {snappedIndex !== null && (
                <span style={{ color: '#3fb950', fontSize: '0.85rem', alignSelf: 'center' }}>
                  🎯 Snapped to fiducial centroid!
                </span>
              )}
            </div>
          )}
        </section>

        <aside className="side-panel">
          <div className="card">
            <h3>Pillar 1: Rectified Mat View</h3>
            {cameraError && (
              <p style={{ color: '#f85149', fontSize: '0.85rem' }}>⚠️ {cameraError}</p>
            )}
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Rust 3x3 Homography DLT Unwarping. Drag green corners to auto-snap to the fiducial bullseyes!
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
              <a
                href="/calibration_mat_letter.pdf"
                download="calibration_mat_letter.pdf"
                style={{ color: '#3fb950', fontSize: '0.85rem', fontWeight: 600, textDecoration: 'underline' }}
              >
                📥 Download Calibration Target (PDF - US Letter)
              </a>
              <a
                href="/calibration_mat_letter.html"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent-cyan)', fontSize: '0.8rem', textDecoration: 'underline' }}
              >
                📄 View Target in Browser
              </a>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
              <canvas
                ref={dewarpedCanvasRef}
                style={{
                  border: '2px solid var(--accent-cyan)',
                  borderRadius: '6px',
                  background: '#000',
                  width: '200px',
                  height: '200px',
                }}
              />
            </div>
          </div>

          <div className="card">
            <h3>Live Engine Telemetry</h3>
            <div className="metric-grid">
              <div className="metric-box">
                <div className="metric-label">Resolution</div>
                <div className="metric-val">
                  {stats ? `${stats.width}x${stats.height}` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">Compute Latency</div>
                <div className="metric-val">
                  {stats ? `${stats.elapsed_ms.toFixed(2)}ms` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">Avg Luminance</div>
                <div className="metric-val">
                  {stats ? stats.avg_brightness.toFixed(1) : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">Browser FPS</div>
                <div className="metric-val">{fps}</div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default App
