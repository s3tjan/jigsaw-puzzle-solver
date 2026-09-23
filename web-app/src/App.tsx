import { useEffect, useRef, useState, useCallback } from 'react'
import init, { greet, process_frame } from './pkg/cv_engine'
import './App.css'

interface FrameStats {
  width: number
  height: number
  avg_brightness: number
  elapsed_ms: number
}

function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [greeting, setGreeting] = useState('')
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [stats, setStats] = useState<FrameStats | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameIdRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(performance.now())
  const frameCountRef = useRef<number>(0)

  // 1. Initialize WASM Engine
  useEffect(() => {
    init()
      .then(() => {
        setWasmReady(true)
        setGreeting(greet('Puzzle Master'))
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

  // 4. Processing Loop: Video -> Canvas -> Uint8Array -> Rust WASM
  const processLoop = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current

    if (video && canvas && video.readyState >= 2 && wasmReady) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        // Downscale for real-time responsiveness if needed (e.g. 640x360 for high FPS CV)
        const targetW = 640
        const targetH = Math.round((video.videoHeight / video.videoWidth) * targetW) || 360

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW
          canvas.height = targetH
        }

        ctx.drawImage(video, 0, 0, targetW, targetH)
        const imgData = ctx.getImageData(0, 0, targetW, targetH)

        try {
          // Pass byte slice directly into Rust WASM
          const rawBytes = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength)
          const metrics: FrameStats = process_frame(rawBytes, targetW, targetH)
          setStats(metrics)
        } catch (e) {
          console.error('Rust process_frame error:', e)
        }

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
  }, [wasmReady])

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

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-title">
          <h1>🧩 Jigsaw Solver</h1>
          <span className="badge">Rust + WASM</span>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Status: {wasmReady ? '⚡ WASM Ready' : '⏳ Initializing...'}
        </div>
      </header>

      <div className="main-content">
        <section className="viewport-panel">
          <div className="panel-header">
            <span>Live Camera Feed</span>
            <span>{isCameraActive ? `🟢 Streaming (${fps} FPS)` : '⚪ Standby'}</span>
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
            </div>
          )}
        </section>

        <aside className="side-panel">
          <div className="card">
            <h3>Engine Link</h3>
            <p style={{ color: 'var(--accent-green)', fontSize: '0.9rem' }}>{greeting}</p>
            {cameraError && (
              <p style={{ color: '#f85149', fontSize: '0.85rem' }}>⚠️ {cameraError}</p>
            )}
          </div>

          <div className="card">
            <h3>Live Telemetry (Rust Engine)</h3>
            <div className="metric-grid">
              <div className="metric-box">
                <div className="metric-label">Resolution</div>
                <div className="metric-val">
                  {stats ? `${stats.width}x${stats.height}` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">Rust Compute</div>
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

          <div className="card">
            <h3>Next Milestone</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Ready to plug in ArUco 4-point corner detection and homography dewarping directly in Rust!
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default App
