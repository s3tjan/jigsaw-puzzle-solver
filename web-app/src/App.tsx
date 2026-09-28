import { useEffect, useRef, useState } from 'react'
import init, {
  dewarp_quad,
  snap_fiducial_corner,
  measure_stage_focus,
  analyze_staged_piece,
} from './pkg/cv_engine'
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

const STORAGE_KEY = 'jigsaw_calibration_corners_v3'

const DEFAULT_CORNERS: [Point2D, Point2D, Point2D, Point2D] = [
  { x: 230, y: 75 },
  { x: 490, y: 75 },
  { x: 490, y: 335 },
  { x: 230, y: 335 },
]

export default function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [focusScore, setFocusScore] = useState<number>(0)
  const [detectedPiece, setDetectedPiece] = useState<ScannedPiece | null>(null)
  const [scannedPieces, setScannedPieces] = useState<ScannedPiece[]>([])

  // Controls
  const [lensDistortion, setLensDistortion] = useState<number>(() => {
    const saved = localStorage.getItem('jigsaw_k1')
    return saved ? parseFloat(saved) : 0.0
  })
  const [sensitivity, setSensitivity] = useState<number>(25.0)
  const [isMirror, setIsMirror] = useState<boolean>(() => {
    return localStorage.getItem('jigsaw_mirror') === 'true'
  })

  useEffect(() => {
    localStorage.setItem('jigsaw_mirror', isMirror.toString())
  }, [isMirror])

  const [corners, setCorners] = useState<[Point2D, Point2D, Point2D, Point2D]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.length === 4) {
          return parsed as [Point2D, Point2D, Point2D, Point2D]
        }
      }
    } catch { }
    return DEFAULT_CORNERS
  })

  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [snappedIdx, setSnappedIdx] = useState<number | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const pieceCanvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameIdRef = useRef<number | null>(null)

  const latestPixelsRef = useRef<{ bytes: Uint8Array; w: number; h: number } | null>(null)
  const lastCvTimeRef = useRef<number>(0)
  const pieceHistoryRef = useRef<ScannedPiece[]>([])
  const cornersRef = useRef(corners)
  cornersRef.current = corners
  const lensK1Ref = useRef(lensDistortion)
  lensK1Ref.current = lensDistortion
  const sensRef = useRef(sensitivity)
  sensRef.current = sensitivity
  const isMirrorRef = useRef(isMirror)
  isMirrorRef.current = isMirror

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(corners))
    } catch { }
  }, [corners])

  useEffect(() => {
    try {
      localStorage.setItem('jigsaw_k1', lensDistortion.toString())
    } catch { }
  }, [lensDistortion])

  useEffect(() => {
    init()
      .then(() => setWasmReady(true))
      .catch((err) => {
        console.error('Failed to init WASM:', err)
        setCameraError('WASM engine failed to load.')
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
        setCameraError(fallbackErr.message || 'Camera access error.')
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
    setDetectedPiece(null)
    latestPixelsRef.current = null
  }

  // Radial distortion mapping helpers
  const distortPt = (x: number, y: number, w: number, h: number, k1: number): Point2D => {
    if (Math.abs(k1) <= 1e-4) return { x, y }
    const cx = w * 0.5
    const cy = h * 0.5
    const diag = Math.hypot(cx, cy)
    const normX = (x - cx) / diag
    const normY = (y - cy) / diag
    const factor = 1.0 + k1 * (normX * normX + normY * normY)
    return {
      x: cx + normX * factor * diag,
      y: cy + normY * factor * diag,
    }
  }

  const undistortPt = (x: number, y: number, w: number, h: number, k1: number): Point2D => {
    if (Math.abs(k1) <= 1e-4) return { x, y }
    const cx = w * 0.5
    const cy = h * 0.5
    const diag = Math.hypot(cx, cy)
    const distX = (x - cx) / diag
    const distY = (y - cy) / diag
    const rDist = Math.hypot(distX, distY)
    if (rDist < 1e-6) return { x, y }
    let rUn = rDist
    for (let iter = 0; iter < 5; iter++) {
      const f = rUn * (1.0 + k1 * rUn * rUn) - rDist
      const df = 1.0 + 3.0 * k1 * rUn * rUn
      if (Math.abs(df) > 1e-6) rUn -= f / df
    }
    const scale = Math.max(0.1, Math.min(3.0, rUn / rDist))
    return {
      x: cx + distX * scale * diag,
      y: cy + distY * scale * diag,
    }
  }

  // Draw Camera Overlay
  const drawCameraOverlay = (
    w: number,
    h: number,
    pts: [Point2D, Point2D, Point2D, Point2D],
    lensK1: number
  ) => {
    const overlay = overlayCanvasRef.current
    const video = videoRef.current
    if (!overlay) return
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w
      overlay.height = h
    }

    if (video && video.clientWidth > 0 && video.clientHeight > 0) {
      overlay.style.width = `${video.clientWidth}px`
      overlay.style.height = `${video.clientHeight}px`
    }

    const ctx = overlay.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    // 1. Draw boundary quad connecting the 4 corners (classic CV green)
    ctx.beginPath()
    ctx.strokeStyle = '#00e676'
    ctx.lineWidth = 2.0
    const SAMPLES = 16
    for (let side = 0; side < 4; side++) {
      const p1 = undistortPt(pts[side].x, pts[side].y, w, h, lensK1)
      const p2 = undistortPt(pts[(side + 1) % 4].x, pts[(side + 1) % 4].y, w, h, lensK1)
      for (let s = 0; s <= SAMPLES; s++) {
        const t = s / SAMPLES
        const px = p1.x + (p2.x - p1.x) * t
        const py = p1.y + (p2.y - p1.y) * t
        const dPt = distortPt(px, py, w, h, lensK1)
        if (side === 0 && s === 0) ctx.moveTo(dPt.x, dPt.y)
        else ctx.lineTo(dPt.x, dPt.y)
      }
    }
    ctx.closePath()
    ctx.stroke()

    // 2. Draw 4 Fiducial Handles
    const labels = ['TL 0', 'TR 1', 'BR 2', 'BL 3']
    pts.forEach((pt, i) => {
      const isDragging = i === draggingIdx
      const isSnapped = i === snappedIdx
      const color = isDragging ? '#ff9100' : isSnapped ? '#00e676' : '#00e676'

      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 16, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth = isDragging ? 3.0 : 2.0
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.0
      ctx.stroke()

      // Crosshair ticks
      ctx.beginPath()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.moveTo(pt.x - 20, pt.y)
      ctx.lineTo(pt.x - 6, pt.y)
      ctx.moveTo(pt.x + 6, pt.y)
      ctx.lineTo(pt.x + 20, pt.y)
      ctx.moveTo(pt.x, pt.y - 20)
      ctx.lineTo(pt.x, pt.y - 6)
      ctx.moveTo(pt.x, pt.y + 6)
      ctx.lineTo(pt.x, pt.y + 20)
      ctx.stroke()

      // Corner Label (Bold, High Contrast)
      ctx.font = 'bold 12px monospace'
      ctx.fillStyle = '#0d1117'
      ctx.fillRect(pt.x + 14, pt.y - 18, 36, 16)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.0
      ctx.strokeRect(pt.x + 14, pt.y - 18, 36, 16)
      ctx.fillStyle = color
      ctx.fillText(labels[i], pt.x + 17, pt.y - 5)
    })
  }

  // Draw Diagnostic Overlay on 1:1 Piece Canvas
  const drawPieceDiagnostics = (ctx: CanvasRenderingContext2D, piece: ScannedPiece) => {
    // 1. Draw crisp continuous outer boundary (clean green line, no blur or glow)
    if (piece.contour_points.length > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(piece.contour_points[0].x, piece.contour_points[0].y)
      for (let i = 1; i < piece.contour_points.length; i++) {
        ctx.lineTo(piece.contour_points[i].x, piece.contour_points[i].y)
      }
      ctx.closePath()

      ctx.strokeStyle = '#00e676'
      ctx.lineWidth = 2.0
      ctx.stroke()

      ctx.fillStyle = 'rgba(0, 230, 118, 0.05)'
      ctx.fill()
      ctx.restore()
    }

    // Clean, readable, non-neon colors:
    // Flat: Purple (#9c27b0), Tab: Blue (#1976d2), Hole: Amber (#f57c00)
    const edgeColors: Record<string, string> = {
      Tab: '#1976d2',
      Hole: '#f57c00',
      Flat: '#9c27b0',
    }

    // 2. Draw 4 Core Baseline Chords with smart outward-offset badges
    piece.edges.forEach((edge, i) => {
      const color = edgeColors[edge.edge_type] || '#333333'

      ctx.save()
      ctx.beginPath()
      ctx.moveTo(edge.start_corner.x, edge.start_corner.y)
      ctx.lineTo(edge.end_corner.x, edge.end_corner.y)
      ctx.strokeStyle = color
      ctx.lineWidth = 2.0
      ctx.setLineDash([6, 4])
      ctx.stroke()
      ctx.restore()

      // Calculate unit normal vector pointing away from piece center (outward)
      const midX = (edge.start_corner.x + edge.end_corner.x) * 0.5
      const midY = (edge.start_corner.y + edge.end_corner.y) * 0.5
      const toMidX = midX - piece.center.x
      const toMidY = midY - piece.center.y
      const toMidDist = Math.hypot(toMidX, toMidY) || 1.0
      const normX = toMidX / toMidDist
      const normY = toMidY / toMidDist

      // Offset badge outward by 20px so it never obscures the edge contour or tab
      const badgeX = midX + normX * 20.0
      const badgeY = midY + normY * 20.0
      const label = `E${i}: ${edge.edge_type}`

      ctx.font = 'bold 11px monospace'
      const tw = ctx.measureText(label).width
      const bw = tw + 14
      const bh = 18

      ctx.fillStyle = 'rgba(20, 25, 30, 0.92)'
      ctx.beginPath()
      ctx.roundRect(badgeX - bw / 2, badgeY - bh / 2, bw, bh, 3)
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, badgeX, badgeY)
    })

    // 3. Draw 4 Core Physical Corners (C0..C3) (solid white pins with dark borders)
    piece.corners.forEach((pt, i) => {
      // Solid outer ring
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 6.0, 0, Math.PI * 2)
      ctx.fillStyle = '#d32f2f' // Solid red pin
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2.0
      ctx.stroke()

      // Center white dot
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 2.0, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()

      // Outward offset for corner label
      const toCX = pt.x - piece.center.x
      const toCY = pt.y - piece.center.y
      const toCDist = Math.hypot(toCX, toCY) || 1.0
      const tagX = pt.x + (toCX / toCDist) * 18.0
      const tagY = pt.y + (toCY / toCDist) * 18.0

      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = 'rgba(20, 25, 30, 0.90)'
      ctx.beginPath()
      ctx.roundRect(tagX - 11, tagY - 8, 22, 16, 2)
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.0
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`C${i}`, tagX, tagY)
    })
  }

  // Main Render & CV Loop
  useEffect(() => {
    let active = true

    const loop = () => {
      if (!active) return

      const video = videoRef.current
      const canvas = canvasRef.current
      const pCanvas = pieceCanvasRef.current

      if (video && canvas && video.readyState >= 2 && video.videoWidth > 0) {
        const targetW = video.videoWidth
        const targetH = video.videoHeight

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW
          canvas.height = targetH
        }

        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx) {
          if (isMirrorRef.current) {
            ctx.save()
            ctx.translate(targetW, 0)
            ctx.scale(-1, 1)
            ctx.drawImage(video, 0, 0, targetW, targetH)
            ctx.restore()
          } else {
            ctx.drawImage(video, 0, 0, targetW, targetH)
          }
          const imgData = ctx.getImageData(0, 0, targetW, targetH)
          const rawBytes = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength)
          latestPixelsRef.current = { bytes: rawBytes, w: targetW, h: targetH }

          const now = performance.now()
          // Run Rust WASM piece analysis ~6 times/sec (every 160ms)
          if (now - lastCvTimeRef.current >= 160 && wasmReady) {
            lastCvTimeRef.current = now

            const curCorners = cornersRef.current
            const curK1 = lensK1Ref.current
            const curSens = sensRef.current

            // Optical focus score
            const mtf = measure_stage_focus(
              rawBytes, targetW, targetH,
              curCorners[0].x, curCorners[0].y,
              curCorners[1].x, curCorners[1].y,
              curCorners[2].x, curCorners[2].y,
              curCorners[3].x, curCorners[3].y
            )
            setFocusScore(mtf)

            // Rectify staging arena
            const dstW = 384
            const dstH = 384

            try {
              const dewarped = dewarp_quad(
                rawBytes, targetW, targetH,
                curCorners[0].x, curCorners[0].y,
                curCorners[1].x, curCorners[1].y,
                curCorners[2].x, curCorners[2].y,
                curCorners[3].x, curCorners[3].y,
                dstW, dstH, curK1
              )

              // Piece boundary & corner analysis
              const result = analyze_staged_piece(dewarped, dstW, dstH, curSens)
              const rawPiece: ScannedPiece | null = result?.piece || null

              // Multi-Frame Stability Consensus Filter:
              // Maintains a sliding window (5 frames) of scanned piece geometries.
              // If the piece is moved/removed, the buffer resets immediately.
              // If the piece is steady, we take the mode of classification and median of corner coordinates.
              let stablePiece: ScannedPiece | null = null

              if (rawPiece) {
                const history = pieceHistoryRef.current
                // Check if rawPiece is roughly at the same location as previous frames (< 8px movement)
                const isContinuous = history.length > 0 &&
                  Math.hypot(rawPiece.center.x - history[0].center.x, rawPiece.center.y - history[0].center.y) < 8.0

                if (!isContinuous) {
                  pieceHistoryRef.current = [rawPiece]
                  stablePiece = rawPiece
                } else {
                  history.unshift(rawPiece)
                  if (history.length > 5) history.pop()

                  // Consensus Edge Types (majority vote per cardinal edge)
                  const consensusEdges = rawPiece.edges.map((edge, eIdx) => {
                    const votes: Record<string, number> = { Flat: 0, Tab: 0, Hole: 0 }
                    for (const hp of history) {
                      votes[hp.edges[eIdx].edge_type] = (votes[hp.edges[eIdx].edge_type] || 0) + 1
                    }
                    const bestType = (Object.keys(votes) as ('Flat' | 'Tab' | 'Hole')[]).reduce((a, b) =>
                      votes[a] >= votes[b] ? a : b
                    )
                    return { ...edge, edge_type: bestType }
                  }) as [PieceEdge, PieceEdge, PieceEdge, PieceEdge]

                  const flatCount = consensusEdges.filter(e => e.edge_type === 'Flat').length
                  const isCorner = flatCount === 2
                  const isBorder = flatCount === 1

                  // Median Corner Smoothing (eliminates 1-2px sensor noise jitter)
                  const medianCorners = [0, 1, 2, 3].map((cIdx) => {
                    const xs = history.map(hp => hp.corners[cIdx].x).sort((a, b) => a - b)
                    const ys = history.map(hp => hp.corners[cIdx].y).sort((a, b) => a - b)
                    const mid = Math.floor(xs.length / 2)
                    return { x: xs[mid], y: ys[mid] }
                  }) as [Point2D, Point2D, Point2D, Point2D]

                  stablePiece = {
                    ...rawPiece,
                    corners: medianCorners,
                    edges: consensusEdges,
                    is_corner: isCorner,
                    is_border: isBorder,
                  }
                }
              } else {
                pieceHistoryRef.current = []
              }

              setDetectedPiece(stablePiece)

              // Render rectified piece view
              if (pCanvas) {
                if (pCanvas.width !== dstW || pCanvas.height !== dstH) {
                  pCanvas.width = dstW
                  pCanvas.height = dstH
                }
                const pCtx = pCanvas.getContext('2d')
                if (pCtx) {
                  const pImg = pCtx.createImageData(dstW, dstH)
                  pImg.data.set(dewarped)
                  pCtx.putImageData(pImg, 0, 0)

                  if (stablePiece) {
                    drawPieceDiagnostics(pCtx, stablePiece)
                  }
                }
              }
            } catch (cvErr) {
              console.warn('[CV] Frame processing error:', cvErr)
            }
          }

          // Draw camera overlay every frame
          drawCameraOverlay(targetW, targetH, cornersRef.current, lensK1Ref.current)
        }
      }

      animFrameIdRef.current = requestAnimationFrame(loop)
    }

    if (isCameraActive) {
      animFrameIdRef.current = requestAnimationFrame(loop)
    }

    return () => {
      active = false
      if (animFrameIdRef.current) cancelAnimationFrame(animFrameIdRef.current)
    }
  }, [isCameraActive, wasmReady])

  // Mouse & Pointer drag for corner fiducials
  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    let rawX = (e.clientX - rect.left) * scaleX
    if (isMirrorRef.current) {
      rawX = canvas.width - rawX
    }
    return {
      x: rawX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const pt = getCanvasCoords(e)
    const HIT_RADIUS = 30
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(corners[i].x - pt.x, corners[i].y - pt.y) <= HIT_RADIUS) {
        setDraggingIdx(i)
          ; (e.target as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx === null) return
    const pt = getCanvasCoords(e)
    const newCorners = [...corners] as [Point2D, Point2D, Point2D, Point2D]
    newCorners[draggingIdx] = pt
    setCorners(newCorners)
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingIdx !== null) {
      const idx = draggingIdx
      setDraggingIdx(null)
      try {
        ; (e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch { }

      // Sub-pixel snap on release
      if (latestPixelsRef.current && wasmReady) {
        const { bytes, w, h } = latestPixelsRef.current
        const snapped = snap_fiducial_corner(bytes, w, h, corners[idx].x, corners[idx].y, 32)
        if (snapped && snapped.length >= 2) {
          const newCorners = [...corners] as [Point2D, Point2D, Point2D, Point2D]
          newCorners[idx] = { x: snapped[0], y: snapped[1] }
          setCorners(newCorners)
          setSnappedIdx(idx)
          setTimeout(() => setSnappedIdx(null), 1000)
        }
      }
    }
  }

  const handleSnapAll = () => {
    if (latestPixelsRef.current && wasmReady) {
      const { bytes, w, h } = latestPixelsRef.current
      const newCorners = corners.map((c) => {
        const snapped = snap_fiducial_corner(bytes, w, h, c.x, c.y, 40)
        return { x: snapped[0], y: snapped[1] }
      })
      setCorners(newCorners as [Point2D, Point2D, Point2D, Point2D])
      setSnappedIdx(99)
      setTimeout(() => setSnappedIdx(null), 1000)
    }
  }

  const handleRecordPiece = () => {
    if (detectedPiece) {
      setScannedPieces((prev) => [detectedPiece, ...prev])
    }
  }

  // Lightweight Snapshot Export (<150 KB JPEG + JSON diagnostics) for debugging
  const handleExportSnapshot = () => {
    const pCanvas = pieceCanvasRef.current
    if (!pCanvas) return

    // Convert 384x384 canvas directly to lightweight JPEG (~30-50 KB)
    const dataUrl = pCanvas.toDataURL('image/jpeg', 0.85)

    const snapshotPayload = {
      timestamp: new Date().toISOString(),
      piece: detectedPiece,
      lensDistortion,
      sensitivity,
      corners,
      imageJpegBase64: dataUrl,
    }

    const blob = new Blob([JSON.stringify(snapshotPayload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `piece_snapshot_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Keyboard shortcut Space to capture
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return
      if (e.code === 'Space') {
        e.preventDefault()
        handleRecordPiece()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [detectedPiece])

  return (
    <div className="app-container">
      {/* 1. Header Bar */}
      <header className="app-header">
        <div className="header-brand">
          <strong>JIGSAW SOLVER</strong>
          <span className="badge">100mm MAT</span>
        </div>

        <div className="header-status">
          <span className="status-item">
            CAMERA: <b className={isCameraActive ? 'green' : 'red'}>{isCameraActive ? 'ACTIVE' : 'OFFLINE'}</b>
          </span>
          <span className="status-item">
            FOCUS: <b className={focusScore >= 40 ? 'green' : focusScore >= 20 ? 'yellow' : 'red'}>{focusScore.toFixed(0)}%</b>
          </span>
          <span className="status-item">
            PIECES: <b>{scannedPieces.length}</b>
          </span>
        </div>
      </header>

      {/* 2. Side-by-Side Main Workbench */}
      <main className="main-workbench">
        {/* Left: Overhead Camera */}
        <section className="workbench-panel">
          <div className="panel-header">
            <span>[1] CAMERA VIEW</span>
            <div className="panel-actions">
              {isCameraActive ? (
                <button className="btn small" onClick={stopCamera}>STOP CAMERA</button>
              ) : (
                <button className="btn small primary" onClick={startCamera}>START CAMERA</button>
              )}
              <button
                className={`btn small ${isMirror ? 'primary' : ''}`}
                onClick={() => setIsMirror(!isMirror)}
                title="Toggle horizontal mirror"
              >
                {isMirror ? 'MIRRORED' : 'MIRROR'}
              </button>
              <button className="btn small" onClick={handleSnapAll} title="Snap fiducial corners to nearest target">
                SNAP CORNERS
              </button>
            </div>
          </div>

          <div className="panel-view">
            <video
              ref={videoRef}
              playsInline
              muted
              className={`camera-video ${isMirror ? 'mirrored' : ''}`}
              style={{ display: isCameraActive ? 'block' : 'none' }}
            />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {isCameraActive && (
              <canvas
                ref={overlayCanvasRef}
                className={`camera-overlay ${isMirror ? 'mirrored' : ''}`}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              />
            )}
            {!isCameraActive && (
              <div className="camera-empty">
                {cameraError ? <span className="red">{cameraError}</span> : <span>Camera is inactive.</span>}
                <button className="btn primary" onClick={startCamera}>ACTIVATE CAMERA</button>
              </div>
            )}
          </div>
        </section>

        {/* Right: Rectified Piece Diagnostics */}
        <section className="workbench-panel">
          <div className="panel-header">
            <span>[2] DETECTED PIECE &amp; METRICS</span>
            <div className="panel-actions">
              <button
                className="btn small"
                disabled={!detectedPiece}
                onClick={handleExportSnapshot}
                title="Save lightweight JSON + JPEG diagnostic snapshot (<100KB)"
              >
                SAVE SNAPSHOT
              </button>
              <span className={detectedPiece ? 'green' : 'muted'} style={{ marginLeft: 6 }}>
                {detectedPiece ? 'TARGET IN STAGE' : 'NO PIECE'}
              </span>
            </div>
          </div>

          <div className="panel-body">
            <div className="piece-canvas-wrapper">
              <canvas ref={pieceCanvasRef} width={384} height={384} className="piece-canvas" />
            </div>

            {/* Piece Classification Details */}
            <div className="piece-data-card">
              <div className="data-row">
                <span className="data-label">TYPE:</span>
                <span className={`data-val ${detectedPiece ? (detectedPiece.is_corner ? 'red' : detectedPiece.is_border ? 'yellow' : 'green') : ''}`}>
                  {detectedPiece ? (detectedPiece.is_corner ? 'CORNER' : detectedPiece.is_border ? 'BORDER' : 'INTERIOR') : '--'}
                </span>
              </div>

              <div className="data-row">
                <span className="data-label">SIZE:</span>
                <span className="data-val">
                  {detectedPiece
                    ? `${(detectedPiece.bounding_width * 0.25).toFixed(1)} × ${(detectedPiece.bounding_height * 0.25).toFixed(1)} mm`
                    : '--'}
                </span>
              </div>

              <div className="data-row">
                <span className="data-label">ROTATION:</span>
                <span className="data-val">
                  {detectedPiece ? `${((detectedPiece.rotation_angle_rad * 180) / Math.PI).toFixed(0)}°` : '--'}
                </span>
              </div>

              <div className="data-row">
                <span className="data-label">EDGES:</span>
                <div className="edge-pills">
                  {detectedPiece ? (
                    detectedPiece.edges.map((e, idx) => (
                      <span key={idx} className={`pill ${e.edge_type.toLowerCase()}`}>
                        E{idx}: {e.edge_type}
                      </span>
                    ))
                  ) : (
                    <span className="muted">--</span>
                  )}
                </div>
              </div>
            </div>

            <button
              className="btn primary record-btn"
              disabled={!detectedPiece}
              onClick={handleRecordPiece}
            >
              RECORD PIECE [SPACE]
            </button>
          </div>
        </section>
      </main>

      {/* 3. Bottom Controls & Scanned Piece History */}
      <footer className="app-footer">
        <div className="controls-row">
          <div className="control-group">
            <label>SENSITIVITY:</label>
            <input
              type="range"
              min="10"
              max="60"
              step="1"
              value={sensitivity}
              onChange={(e) => setSensitivity(parseFloat(e.target.value))}
            />
            <code>{sensitivity.toFixed(0)}</code>
          </div>

          <div className="control-group">
            <label>LENS K1:</label>
            <input
              type="range"
              min="-0.30"
              max="0.30"
              step="0.01"
              value={lensDistortion}
              onChange={(e) => setLensDistortion(parseFloat(e.target.value))}
            />
            <code>{lensDistortion.toFixed(2)}</code>
            <button className="btn tiny" onClick={() => setLensDistortion(0)}>RESET</button>
          </div>

          <a href="/calibration_mat.svg" download="staging_mat_100mm.svg" className="btn small">
            DOWNLOAD MAT SVG
          </a>
        </div>

        {/* History Strip */}
        {scannedPieces.length > 0 && (
          <div className="history-strip">
            <span className="history-label">SCANNED ({scannedPieces.length}):</span>
            <div className="history-items">
              {scannedPieces.map((p, idx) => (
                <span key={idx} className={`history-pill ${p.is_corner ? 'red' : p.is_border ? 'yellow' : 'green'}`}>
                  #{scannedPieces.length - idx} {p.is_corner ? 'CORNER' : p.is_border ? 'BORDER' : 'INNER'}
                </span>
              ))}
            </div>
            <button className="btn tiny" onClick={() => setScannedPieces([])}>CLEAR</button>
          </div>
        )}
      </footer>
    </div>
  )
}
