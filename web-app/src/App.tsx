import { useEffect, useRef, useState, useCallback } from 'react'
import init, { greet, process_frame, dewarp_quad } from './pkg/cv_engine'
import './App.css'

interface Point2D {
  x: number
  y: number
}

interface MatCorners {
  top_left: Point2D
  top_right: Point2D
  bottom_right: Point2D
  bottom_left: Point2D
}

interface FrameAnalysis {
  width: number
  height: number
  avg_brightness: number
  elapsed_ms: number
  corners: MatCorners | null
  dewarped_ready: boolean
}

function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [stats, setStats] = useState<FrameAnalysis | null>(null)
  const [autoDewarp, setAutoDewarp] = useState(true)

  // Interactive/Custom calibration corners (can be dragged or auto-detected)
  const [corners, setCorners] = useState<[Point2D, Point2D, Point2D, Point2D]>([
    { x: 96, y: 54 },
    { x: 544, y: 54 },
    { x: 544, y: 306 },
    { x: 96, y: 306 },
  ])
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const dewarpedCanvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameIdRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(performance.now())
  const frameCountRef = useRef<number>(0)

  // 1. Initialize WASM Engine
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

  // 2. Start Camera
  const startCamera = async () => {
    try {
      setCameraError(null)
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      })

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        setIsCameraActive(true)
      }
    } catch (err: any) {
      console.error('Camera access error:', err)
      setCameraError(err.message || 'Permission denied or no camera found.')
    }
  }

  // 3. Stop Camera
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
  }

  // 4. Draw HUD / AR Quad overlay
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

    // Corner anchor points
    const labels = ['TL (0)', 'TR (1)', 'BR (2)', 'BL (3)']
    pts.forEach((pt, i) => {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2)
      ctx.fillStyle = i === draggingIdx ? '#ffd33d' : '#3fb950'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.font = '10px monospace'
      ctx.fillText(labels[i], pt.x + 12, pt.y + 4)
    })
  }

  // 5. Processing Loop: Video -> Canvas -> Rust WASM Dewarp
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
          const analysis: FrameAnalysis = process_frame(rawBytes, targetW, targetH)
          setStats(analysis)

          // Dewarp using current 4-corners into a square 256x256 orthographic mat view
          if (autoDewarp && dewarpedCanvas) {
            const dstW = 256
            const dstH = 256
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
  }, [wasmReady, corners, autoDewarp, draggingIdx])

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

  // Pointer / Touch / Mouse drag handling with hardware pointer capture
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = 640 / rect.width
    const scaleY = 360 / rect.height
    const mx = (e.clientX - rect.left) * scaleX
    const my = (e.clientY - rect.top) * scaleY

    // Generous detection radius (45px) for easy grabbing on desktop and mobile touch
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

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx !== null) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {}
      setDraggingIdx(null)
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-title">
          <h1>🧩 Jigsaw Solver</h1>
          <span className="badge">Pillar 1: Calibration & Dewarp</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Status: {wasmReady ? '⚡ WASM Ready' : '⏳ Initializing...'}
        </div>
      </header>

      <div className="main-content">
        <section className="viewport-panel">
          <div className="panel-header">
            <span>Camera Feed & Optical Mat Overlay</span>
            <span>{isCameraActive ? `🟢 60 FPS (${fps} Live)` : '⚪ Standby'}</span>
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
              <button
                onClick={() =>
                  setCorners([
                    { x: 96, y: 54 },
                    { x: 544, y: 54 },
                    { x: 544, y: 306 },
                    { x: 96, y: 306 },
                  ])
                }
              >
                Reset Calibration Corners
              </button>
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
              Rust 3x3 Homography DLT Unwarping. Drag green corners on video to correct optical angle!
            </p>
            <div style={{ marginBottom: '8px' }}>
              <a
                href="/calibration_mat.html"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent-cyan)', fontSize: '0.8rem', textDecoration: 'underline' }}
              >
                📄 Open Printable Calibration Mat (A4/Letter)
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
                <div className="metric-label">Homography Latency</div>
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
