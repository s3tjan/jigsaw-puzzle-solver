import { useEffect, useRef, useState, useCallback } from 'react'
import init, { greet, process_frame, dewarp_quad, snap_fiducial_corner, analyze_staged_piece } from './pkg/cv_engine'
import './App.css'

interface Point2D {
  x: number
  y: number
}

interface PieceEdge {
  edge_type: 'Flat' | 'Tab' | 'Hole'
  start_corner: Point2D
  end_corner: Point2D
  curvature_depth: number
  curve_samples: Point2D[]
}

interface ScannedPiece {
  center: Point2D
  rotation_angle_rad: number
  bounding_width: number
  bounding_height: number
  perimeter_length: number
  corners: [Point2D, Point2D, Point2D, Point2D]
  edges: [PieceEdge, PieceEdge, PieceEdge, PieceEdge]
  contour_points: Point2D[]
  is_corner: boolean
  is_border: boolean
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
  const [detectedPiece, setDetectedPiece] = useState<ScannedPiece | null>(null)
  const [stagedHistory, setStagedHistory] = useState<ScannedPiece[]>([])
  const [autoCaptureNotice, setAutoCaptureNotice] = useState<string | null>(null)

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

  // Motion debouncing & hands-free auto-capture state
  const steadySinceRef = useRef<number | null>(null)
  const lastCenterRef = useRef<Point2D | null>(null)
  const hasCapturedRef = useRef<boolean>(false)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(corners))
    } catch {}
  }, [corners])

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
      console.warn('1080p fallback trigger:', err)
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
    setDetectedPiece(null)
    latestPixelsRef.current = null
  }

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

    const labels = ['TL (0)', 'TR (1)', 'BR (2)', 'BL (3)']
    pts.forEach((pt, i) => {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2)
      ctx.fillStyle = i === draggingIdx ? '#ffd33d' : i === snappedIndex ? '#3fb950' : '#58a6ff'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()

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

  const drawPieceDiagnostics = (ctx: CanvasRenderingContext2D, piece: ScannedPiece) => {
    if (piece.contour_points.length > 0) {
      ctx.beginPath()
      ctx.moveTo(piece.contour_points[0].x, piece.contour_points[0].y)
      for (let i = 1; i < piece.contour_points.length; i++) {
        ctx.lineTo(piece.contour_points[i].x, piece.contour_points[i].y)
      }
      ctx.closePath()
      ctx.strokeStyle = '#3fb950'
      ctx.lineWidth = 2.5
      ctx.stroke()
      ctx.fillStyle = 'rgba(63, 185, 80, 0.15)'
      ctx.fill()
    }

    piece.corners.forEach((pt, i) => {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#f85149'
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = '#ffffff'
      ctx.font = '9px monospace'
      ctx.fillText(`C${i}`, pt.x + 6, pt.y - 4)
    })

    const edgeColors: Record<string, string> = {
      Tab: '#388bfd',
      Hole: '#d29922',
      Flat: '#a371f7',
    }

    piece.edges.forEach((edge, i) => {
      const midX = (edge.start_corner.x + edge.end_corner.x) / 2
      const midY = (edge.start_corner.y + edge.end_corner.y) / 2
      ctx.fillStyle = edgeColors[edge.edge_type] || '#ffffff'
      ctx.font = 'bold 10px monospace'
      ctx.fillText(`E${i}: ${edge.edge_type}`, midX - 20, midY)
    })
  }

  // Hands-free auto capture sound using Web Audio API
  const playCaptureTone = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(587.33, ctx.currentTime) // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12) // A5
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.2)
    } catch {}
  }

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

              // Run Pillar 3 piece boundary contour segmentation
              const piece: ScannedPiece | null = analyze_staged_piece(dewarpedBytes, dstW, dstH)
              setDetectedPiece(piece)

              if (piece) {
                drawPieceDiagnostics(dCtx, piece)

                // Hands-Free Auto-Capture Motion Debouncing:
                // Check if piece centroid has been stationary for 500ms
                const now = performance.now()
                if (lastCenterRef.current) {
                  const dist = Math.hypot(piece.center.x - lastCenterRef.current.x, piece.center.y - lastCenterRef.current.y)
                  if (dist < 2.5) {
                    if (steadySinceRef.current === null) {
                      steadySinceRef.current = now
                    } else if (now - steadySinceRef.current >= 500 && !hasCapturedRef.current) {
                      // Piece is completely steady: Auto-Capture!
                      hasCapturedRef.current = true
                      playCaptureTone()
                      setStagedHistory((prev) => [piece, ...prev.slice(0, 11)])
                      setAutoCaptureNotice('✨ Piece auto-captured!')
                      setTimeout(() => setAutoCaptureNotice(null), 1500)
                    }
                  } else {
                    // Hand or piece moved
                    steadySinceRef.current = null
                    hasCapturedRef.current = false
                  }
                }
                lastCenterRef.current = piece.center
              } else {
                // Arena empty
                steadySinceRef.current = null
                lastCenterRef.current = null
                hasCapturedRef.current = false
              }
            }
          }
        } catch (e) {
          console.error('Rust compute error:', e)
        }

        drawOverlay(targetW, targetH, corners)

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

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx !== null) {
      const idx = draggingIdx
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {}
      setDraggingIdx(null)

      if (latestPixelsRef.current && wasmReady) {
        const { bytes, w, h } = latestPixelsRef.current
        const currentPt = corners[idx]
        const snapped = snap_fiducial_corner(bytes, w, h, currentPt.x, currentPt.y, 28)
        if (snapped && snapped.length >= 2) {
          const sx = snapped[0]
          const sy = snapped[1]
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

  const handleManualLockPiece = () => {
    if (detectedPiece) {
      playCaptureTone()
      setStagedHistory((prev) => [detectedPiece, ...prev.slice(0, 11)])
    }
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-title">
          <h1>🧩 Jigsaw Solver</h1>
          <span className="badge">Pillars 1 & 3: CV Engine Active</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Status: {wasmReady ? '⚡ Rust WASM Ready' : '⏳ Initializing...'}
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
              {detectedPiece && (
                <button className="primary" onClick={handleManualLockPiece}>
                  🔒 Capture Piece #{stagedHistory.length + 1}
                </button>
              )}
              {autoCaptureNotice && (
                <span style={{ color: '#3fb950', fontSize: '0.85rem', fontWeight: 600, alignSelf: 'center' }}>
                  {autoCaptureNotice}
                </span>
              )}
              {snappedIndex !== null && (
                <span style={{ color: '#58a6ff', fontSize: '0.85rem', alignSelf: 'center' }}>
                  🎯 Snapped to fiducial!
                </span>
              )}
            </div>
          )}
        </section>

        <aside className="side-panel">
          <div className="card">
            <h3>Pillar 3: Piece Boundary & Contour Extraction</h3>
            {cameraError && (
              <p style={{ color: '#f85149', fontSize: '0.85rem' }}>⚠️ {cameraError}</p>
            )}
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Rotated PCA orientation, Gaussian smoothing & auto-capture active.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
              <canvas
                ref={dewarpedCanvasRef}
                style={{
                  border: '2px solid var(--accent-cyan)',
                  borderRadius: '6px',
                  background: '#000',
                  width: '240px',
                  height: '240px',
                }}
              />
            </div>

            {detectedPiece ? (
              <div style={{ fontSize: '0.85rem', marginTop: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>Piece Type:</span>
                  <strong style={{ color: detectedPiece.is_corner ? '#f85149' : detectedPiece.is_border ? '#d29922' : '#3fb950' }}>
                    {detectedPiece.is_corner ? 'Corner Piece 🏆' : detectedPiece.is_border ? 'Border Piece 🧭' : 'Interior Piece 🧩'}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>Dimensions:</span>
                  <code>{(detectedPiece.bounding_width * 0.22).toFixed(1)}mm &times; {(detectedPiece.bounding_height * 0.22).toFixed(1)}mm</code>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>Rotation:</span>
                  <code>{((detectedPiece.rotation_angle_rad * 180) / Math.PI).toFixed(1)}&deg;</code>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Edges:</span>
                  <span>
                    {detectedPiece.edges.map((e, idx) => (
                      <span key={idx} style={{
                        marginLeft: '4px',
                        padding: '1px 4px',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                        background: e.edge_type === 'Tab' ? 'rgba(56, 139, 253, 0.2)' : e.edge_type === 'Hole' ? 'rgba(210, 153, 34, 0.2)' : 'rgba(163, 113, 247, 0.2)',
                        color: e.edge_type === 'Tab' ? '#58a6ff' : e.edge_type === 'Hole' ? '#d29922' : '#a371f7'
                      }}>
                        {e.edge_type}
                      </span>
                    ))}
                  </span>
                </div>
              </div>
            ) : (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', margin: '8px 0' }}>
                ⚪ Staging arena empty. Place a piece on the target.
              </p>
            )}
          </div>

          <div className="card">
            <h3>Captured Pieces ({stagedHistory.length})</h3>
            {stagedHistory.length === 0 ? (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Drop a piece and hold still for 500ms — it will auto-capture hands-free!
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '160px', overflowY: 'auto' }}>
                {stagedHistory.map((p, i) => (
                  <div key={i} style={{
                    fontSize: '0.8rem',
                    padding: '6px 8px',
                    borderRadius: '4px',
                    background: 'rgba(0,0,0,0.25)',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    justifyContent: 'space-between'
                  }}>
                    <span>Piece #{stagedHistory.length - i} ({((p.rotation_angle_rad * 180) / Math.PI).toFixed(0)}&deg;)</span>
                    <span style={{ color: p.is_corner ? '#f85149' : p.is_border ? '#d29922' : '#3fb950', fontWeight: 600 }}>
                      {p.is_corner ? 'Corner' : p.is_border ? 'Border' : 'Interior'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>Live Telemetry</h3>
            <div className="metric-grid">
              <div className="metric-box">
                <div className="metric-label">Resolution</div>
                <div className="metric-val">
                  {stats ? `${stats.width}x${stats.height}` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">Rust Latency</div>
                <div className="metric-val">
                  {stats ? `${stats.elapsed_ms.toFixed(2)}ms` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">Luminance</div>
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
