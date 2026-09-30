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

export interface GroundTruthPiece {
  id: string
  timestamp: string
  expected_type: 'Interior' | 'Border' | 'Corner'
  expected_edges: ['Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole']
  corners: [Point2D, Point2D, Point2D, Point2D]
  contour_points: Point2D[]
  center: Point2D
  bounding_width: number
  bounding_height: number
  imageJpegBase64?: string
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

  // Ground-Truth Labeling Workbench State
  const [isGtMode, setIsGtMode] = useState<boolean>(false)
  const [gtFrozenPiece, setGtFrozenPiece] = useState<ScannedPiece | null>(null)
  const [gtEdges, setGtEdges] = useState<['Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole']>(['Tab', 'Tab', 'Tab', 'Tab'])
  const [gtCorners, setGtCorners] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(null)
  const [draggingGtCorner, setDraggingGtCorner] = useState<number | null>(null)
  const [gtSavedCount, setGtSavedCount] = useState<number>(0)
  const [gtSaveStatus, setGtSaveStatus] = useState<string | null>(null)

  // Fetch count of already saved ground-truth files on mount
  useEffect(() => {
    fetch('/api/ground-truth-count')
      .then(res => res.json())
      .then(data => { if (typeof data.count === 'number') setGtSavedCount(data.count) })
      .catch(() => { })
  }, [])


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

  const isGtModeRef = useRef(isGtMode)
  isGtModeRef.current = isGtMode
  const gtFrozenPieceRef = useRef(gtFrozenPiece)
  gtFrozenPieceRef.current = gtFrozenPiece
  const gtCornersRef = useRef(gtCorners)
  gtCornersRef.current = gtCorners
  const gtEdgesRef = useRef(gtEdges)
  gtEdgesRef.current = gtEdges
  const draggingGtCornerRef = useRef(draggingGtCorner)
  draggingGtCornerRef.current = draggingGtCorner
  const gtFrozenPixelsRef = useRef<Uint8Array | null>(null)
  const latestDewarpedRef = useRef<Uint8Array | null>(null)
  const detectedPieceRef = useRef<ScannedPiece | null>(null)
  detectedPieceRef.current = detectedPiece





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

    // 1. Draw boundary quad connecting the 4 corners (classic CV green, 3.5px thick for sharp extinction)
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(255, 0, 255, 0.75)'
    ctx.lineWidth = 3.5
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

    // 2. High-Visibility Optical Center Crosshair & Reticle
    const cx = w / 2
    const cy = h / 2
    const ARM = 40
    const GAP = 6

    ctx.beginPath()
    ctx.strokeStyle = '#00e5ff' // High-contrast neon cyan
    ctx.lineWidth = 2.0

    // Horizontal arms with center gap
    ctx.moveTo(cx - ARM, cy)
    ctx.lineTo(cx - GAP, cy)
    ctx.moveTo(cx + GAP, cy)
    ctx.lineTo(cx + ARM, cy)

    // Vertical arms with center gap
    ctx.moveTo(cx, cy - ARM)
    ctx.lineTo(cx, cy - GAP)
    ctx.moveTo(cx, cy + GAP)
    ctx.lineTo(cx, cy + ARM)
    ctx.stroke()

    // Central aiming reticle ring
    ctx.beginPath()
    ctx.arc(cx, cy, 14, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.75)'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Sub-pixel white center point
    ctx.beginPath()
    ctx.arc(cx, cy, 2.0, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()

    // 3. Physical Pose & Keystone Balance Indicators (Calculates camera tilt from quad geometry)
    const topWidth = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
    const botWidth = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y)
    const leftHeight = Math.hypot(pts[3].x - pts[0].x, pts[3].y - pts[0].y)
    const rightHeight = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)
    const pitchSkew = ((topWidth - botWidth) / ((topWidth + botWidth) / 2)) * 100
    const yawSkew = ((leftHeight - rightHeight) / ((leftHeight + rightHeight) / 2)) * 100
    const rollAngleDeg = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * (180 / Math.PI)

    // Pose HUD Banner
    ctx.font = '22px monospace'

    ctx.fillStyle = Math.abs(pitchSkew) < 2.5 ? '#00ff00ff' : '#ff0000ff'
    ctx.fillText(`PITCH (Top/Bot):  ${pitchSkew.toFixed(1)}% ${Math.abs(pitchSkew) < 2.5 ? 'SQUARE' : 'TILTED'}`, 18, 26)

    ctx.fillStyle = Math.abs(yawSkew) < 2.5 ? '#00ff00ff' : '#ff0000ff'
    ctx.fillText(`YAW   (L/R Side): ${yawSkew.toFixed(1)}% ${Math.abs(yawSkew) < 2.5 ? 'SQUARE' : 'TILTED'}`, 18, 52)

    ctx.fillStyle = Math.abs(rollAngleDeg) < 1.0 ? '#00ff00ff' : '#ff0000ff'
    ctx.fillText(`ROLL  (Horizon):  ${rollAngleDeg.toFixed(1)}° ${Math.abs(rollAngleDeg) < 1.0 ? 'LEVEL' : 'ROTATED'}`, 18, 74)

    // 4. Draw 4 Fiducial Handles (enlarged ring, longer & thicker crosshairs)
    const labels = ['TL 0', 'TR 1', 'BR 2', 'BL 3']
    pts.forEach((pt, i) => {
      const isDragging = i === draggingIdx
      const isSnapped = i === snappedIdx
      const color = isDragging ? '#ff9100' : isSnapped ? '#00e676' : '#ff00ffff'

      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 26, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth = isDragging ? 3.5 : 2.5
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Longer, thicker crosshair ticks (reaching 28px out with 2.5px width)
      ctx.beginPath()
      ctx.strokeStyle = color
      ctx.lineWidth = 2.5
      ctx.moveTo(pt.x - 28, pt.y)
      ctx.lineTo(pt.x - 8, pt.y)
      ctx.moveTo(pt.x + 8, pt.y)
      ctx.lineTo(pt.x + 28, pt.y)
      ctx.moveTo(pt.x, pt.y - 28)
      ctx.lineTo(pt.x, pt.y - 8)
      ctx.moveTo(pt.x, pt.y + 8)
      ctx.lineTo(pt.x, pt.y + 28)
      ctx.stroke()

      // Corner Label (Bold, High Contrast)
      ctx.font = 'bold 22px monospace'
      ctx.fillStyle = color
      ctx.fillText(labels[i], pt.x + 19, pt.y - 6)
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

    // 3. Draw 4 Core Physical Corners (C0..C3) (solid pins with dark borders)
    piece.corners.forEach((pt, i) => {
      const isDraggingThis = isGtMode && draggingGtCorner === i
      // Solid outer ring
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, isDraggingThis ? 9.0 : 6.0, 0, Math.PI * 2)
      ctx.fillStyle = isGtMode ? '#00e5ff' : '#d32f2f' // Cyan pin in GT mode, Red in live
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
      const tagX = pt.x + (toCX / toCDist) * 20.0
      const tagY = pt.y + (toCY / toCDist) * 20.0

      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = 'rgba(20, 25, 30, 0.90)'
      ctx.beginPath()
      ctx.roundRect(tagX - 11, tagY - 8, 22, 16, 2)
      ctx.fill()
      ctx.strokeStyle = isGtMode ? '#00e5ff' : '#ffffff'
      ctx.lineWidth = 1.0
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`C${i + 1}`, tagX, tagY)
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

              latestDewarpedRef.current = new Uint8Array(dewarped)

              let livePiece: ScannedPiece | null = null

              // Piece boundary & corner analysis (only update live piece if not in GT mode)
              if (!isGtModeRef.current) {
                const result = analyze_staged_piece(dewarped, dstW, dstH, curSens)
                const rawPiece: ScannedPiece | null = result?.piece || null

                // Multi-Frame Stability Consensus Filter:
                if (rawPiece) {
                  const history = pieceHistoryRef.current
                  const isContinuous = history.length > 0 &&
                    Math.hypot(rawPiece.center.x - history[0].center.x, rawPiece.center.y - history[0].center.y) < 8.0

                  if (!isContinuous) {
                    pieceHistoryRef.current = [rawPiece]
                    livePiece = rawPiece
                  } else {
                    history.unshift(rawPiece)
                    if (history.length > 5) history.pop()

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

                    // 1. Median coordinates across recent frames
                    const medianCorners = [0, 1, 2, 3].map((cIdx) => {
                      const xs = history.map(hp => hp.corners[cIdx].x).sort((a, b) => a - b)
                      const ys = history.map(hp => hp.corners[cIdx].y).sort((a, b) => a - b)
                      const mid = Math.floor(xs.length / 2)
                      return { x: xs[mid], y: ys[mid] }
                    }) as [Point2D, Point2D, Point2D, Point2D]

                    // 2. Velocity-gated stabilization: when piece is stationary (displacement < 2.5px),
                    // apply heavy temporal damping (EMA alpha=0.20) to eliminate camera sensor shot-noise wobble.
                    const prevLiveCorners = detectedPieceRef.current?.corners
                    const centerDisplacement = Math.hypot(
                      rawPiece.center.x - history[1]?.center.x || 0,
                      rawPiece.center.y - history[1]?.center.y || 0
                    )

                    const stabilizedCorners = medianCorners.map((mc, cIdx) => {
                      if (prevLiveCorners && centerDisplacement < 2.5) {
                        const prevC = prevLiveCorners[cIdx]
                        const cornerDist = Math.hypot(mc.x - prevC.x, mc.y - prevC.y)
                        // If corner jitter is tiny (< 3.0px), damp it heavily
                        if (cornerDist < 3.0) {
                          return {
                            x: prevC.x * 0.82 + mc.x * 0.18,
                            y: prevC.y * 0.82 + mc.y * 0.18,
                          }
                        }
                      }
                      return mc
                    }) as [Point2D, Point2D, Point2D, Point2D]

                    livePiece = {
                      ...rawPiece,
                      corners: stabilizedCorners,
                      edges: consensusEdges,
                      is_corner: isCorner,
                      is_border: isBorder,
                    }
                  }
                } else {
                  pieceHistoryRef.current = []
                }

                setDetectedPiece(livePiece)
                detectedPieceRef.current = livePiece
              }

              // Render rectified piece view
              if (pCanvas) {
                if (pCanvas.width !== dstW || pCanvas.height !== dstH) {
                  pCanvas.width = dstW
                  pCanvas.height = dstH
                }
                const pCtx = pCanvas.getContext('2d')
                if (pCtx) {
                  // In GT mode, display the exact frozen dewarped pixels so the image is 100% still and unaltered
                  const pixelsToDraw = (isGtModeRef.current && gtFrozenPixelsRef.current)
                    ? gtFrozenPixelsRef.current
                    : dewarped

                  const pImg = pCtx.createImageData(dstW, dstH)
                  pImg.data.set(pixelsToDraw)
                  pCtx.putImageData(pImg, 0, 0)

                  if (isGtModeRef.current && gtFrozenPieceRef.current && gtCornersRef.current) {
                    const frozen = gtFrozenPieceRef.current
                    const activeCorners = gtCornersRef.current
                    const activeEdges = gtEdgesRef.current
                    const mockEdges = frozen.edges.map((e, idx) => ({
                      ...e,
                      edge_type: activeEdges[idx],
                      start_corner: activeCorners[idx],
                      end_corner: activeCorners[(idx + 1) % 4],
                    })) as [PieceEdge, PieceEdge, PieceEdge, PieceEdge]

                    drawPieceDiagnostics(pCtx, {
                      ...frozen,
                      corners: activeCorners,
                      edges: mockEdges,
                    })
                  } else if (livePiece) {
                    drawPieceDiagnostics(pCtx, livePiece)
                  } else if (detectedPieceRef.current) {
                    drawPieceDiagnostics(pCtx, detectedPieceRef.current)
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

  // Freeze current piece into ground truth workbench
  const handleFreezeGroundTruth = () => {
    if (!detectedPiece) return
    if (latestDewarpedRef.current) {
      gtFrozenPixelsRef.current = new Uint8Array(latestDewarpedRef.current)
    }
    setGtFrozenPiece(detectedPiece)
    setGtCorners([...detectedPiece.corners] as [Point2D, Point2D, Point2D, Point2D])
    setGtEdges(detectedPiece.edges.map(e => e.edge_type) as ['Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole'])
    setIsGtMode(true)
    setGtSaveStatus(null)
  }

  const handleExitGtMode = () => {
    setIsGtMode(false)
    gtFrozenPixelsRef.current = null
    setGtFrozenPiece(null)
    setGtCorners(null)
    setDraggingGtCorner(null)
    setGtSaveStatus(null)
  }


  const handleToggleEdgeType = (edgeIdx: number, type: 'Flat' | 'Tab' | 'Hole') => {
    setGtEdges(prev => {
      const next = [...prev] as ['Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole']
      next[edgeIdx] = type
      return next
    })
  }

  // Pointer drag for piece corners directly on the 384x384 piece canvas
  const handlePiecePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isGtMode || !gtCorners) return
    const canvas = pieceCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) * (canvas.width / rect.width)
    const y = (e.clientY - rect.top) * (canvas.height / rect.height)

    // If a corner is already selected, clicking directly moves that corner to the clicked position
    if (draggingGtCorner !== null && gtFrozenPiece) {
      let bestPt = { x, y }
      let minDist = 60.0
      for (const p of gtFrozenPiece.contour_points) {
        const d = Math.hypot(p.x - x, p.y - y)
        if (d < minDist) {
          minDist = d
          bestPt = p
        }
      }
      setGtCorners(prev => {
        if (!prev) return prev
        const next = [...prev] as [Point2D, Point2D, Point2D, Point2D]
        next[draggingGtCorner] = bestPt
        return next
      })
      setDraggingGtCorner(null)
      return
    }

    // Check if clicked near one of the 4 corners (< 25px) to begin dragging
    for (let i = 0; i < 4; i++) {
      const dist = Math.hypot(gtCorners[i].x - x, gtCorners[i].y - y)
      if (dist < 25.0) {
        setDraggingGtCorner(i)
          ; (e.target as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
    }
  }


  const handlePiecePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isGtMode || draggingGtCorner === null || !gtCorners || !gtFrozenPiece) return
    const canvas = pieceCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) * (canvas.width / rect.width)
    const y = (e.clientY - rect.top) * (canvas.height / rect.height)

    // Snap to the closest contour point
    let bestPt = { x, y }
    let minDist = 40.0 // snap radius
    for (const p of gtFrozenPiece.contour_points) {
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < minDist) {
        minDist = d
        bestPt = p
      }
    }

    setGtCorners(prev => {
      if (!prev) return prev
      const next = [...prev] as [Point2D, Point2D, Point2D, Point2D]
      next[draggingGtCorner] = bestPt
      return next
    })
  }

  const handlePiecePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingGtCorner !== null) {
      setDraggingGtCorner(null)
      try {
        ; (e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch { }
    }
  }

  // Save ground truth to backend
  const handleSaveGroundTruth = async () => {
    if (!gtFrozenPiece || !gtCorners) return
    const pCanvas = pieceCanvasRef.current
    const dataUrl = pCanvas ? pCanvas.toDataURL('image/jpeg', 0.85) : undefined

    const flatCount = gtEdges.filter(t => t === 'Flat').length
    const expectedType: 'Interior' | 'Border' | 'Corner' =
      flatCount >= 2 ? 'Corner' : flatCount === 1 ? 'Border' : 'Interior'

    const id = `piece_gt_${Date.now()}`
    const payload: GroundTruthPiece = {
      id,
      timestamp: new Date().toISOString(),
      expected_type: expectedType,
      expected_edges: gtEdges,
      corners: gtCorners,
      contour_points: gtFrozenPiece.contour_points,
      center: gtFrozenPiece.center,
      bounding_width: gtFrozenPiece.bounding_width,
      bounding_height: gtFrozenPiece.bounding_height,
      imageJpegBase64: dataUrl,
    }

    try {
      setGtSaveStatus('Saving...')
      const res = await fetch('/api/save-ground-truth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const result = await res.json()
      if (result.success) {
        setGtSavedCount(prev => prev + 1)
        setGtSaveStatus(`✓ Saved as ${result.file}`)
        setTimeout(() => {
          handleExitGtMode()
        }, 800)
      } else {
        setGtSaveStatus(`Error: ${result.error || 'Failed'}`)
      }
    } catch (err: any) {
      setGtSaveStatus(`Error: ${err.message}`)
    }
  }

  // Keyboard shortcut Space to capture
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (isGtMode) {
          handleSaveGroundTruth()
        } else {
          handleFreezeGroundTruth()
        }
      } else if (e.code === 'Escape' && isGtMode) {
        e.preventDefault()
        handleExitGtMode()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [detectedPiece, isGtMode, gtFrozenPiece, gtCorners, gtEdges])


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

        {/* Center: Rectified Dewarp Canvas (strictly 384x384, never resized) */}
        <section className="workbench-panel" style={{ width: 416, flexShrink: 0 }}>
          <div className="panel-header">
            <span>[2] RECTIFIED PIECE INSPECTION</span>
            <div className="panel-actions">
              <span className={detectedPiece ? 'green' : 'muted'}>
                {detectedPiece ? 'TARGET IN STAGE' : 'NO PIECE'}
              </span>
            </div>
          </div>

          <div className="panel-body" style={{ alignItems: 'center', justifyContent: 'flex-start', padding: 16 }}>
            <div className="piece-canvas-wrapper">
              <canvas
                ref={pieceCanvasRef}
                width={384}
                height={384}
                className={`piece-canvas ${isGtMode ? 'piece-canvas-interactive' : ''}`}
                onPointerDown={handlePiecePointerDown}
                onPointerMove={handlePiecePointerMove}
                onPointerUp={handlePiecePointerUp}
                onPointerCancel={handlePiecePointerUp}
              />
            </div>

            <div style={{ display: 'flex', gap: 8, width: 384, marginTop: 12 }}>
              <button
                className="btn small"
                disabled={!detectedPiece}
                onClick={handleExportSnapshot}
                style={{ flex: 1 }}
                title="Save lightweight JSON + JPEG diagnostic snapshot (<100KB)"
              >
                SAVE SNAPSHOT
              </button>
              <button
                className="btn primary small"
                disabled={!detectedPiece}
                onClick={handleRecordPiece}
                style={{ flex: 1 }}
                title="Add to session piece list"
              >
                RECORD PIECE
              </button>
            </div>
          </div>
        </section>

        {/* Right: Dedicated Benchmark Ground-Truth Station */}
        <section className="workbench-panel" style={{ width: 360, flexShrink: 0 }}>
          <div className="panel-header">
            <span>[3] GROUND TRUTH STATION</span>
            <div className="panel-actions">
              <span className="badge" style={{ background: '#2b6cb0' }}>BENCHMARK #{gtSavedCount}</span>
            </div>
          </div>

          <div className="panel-body" style={{ padding: 12, gap: 10, alignItems: 'stretch' }}>
            {!isGtMode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', justifyContent: 'space-between' }}>
                <div className="piece-data-card" style={{ width: '100%', maxWidth: 'none' }}>
                  <div className="data-row">
                    <span className="data-label">AUTO TYPE:</span>
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
                    <span className="data-label">AUTO EDGES:</span>
                    <div className="edge-pills">
                      {detectedPiece ? (
                        detectedPiece.edges.map((e, idx) => (
                          <span key={idx} className={`pill ${e.edge_type.toLowerCase()}`}>
                            E{idx + 1}: {e.edge_type}
                          </span>
                        ))
                      ) : (
                        <span className="muted">--</span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ background: '#161b22', padding: 12, borderRadius: 4, border: '1px solid var(--border)', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  <strong style={{ color: '#fff' }}>Ground Truth Benchmark:</strong>
                  <br />
                  Freeze the current frame to accurately place corners and specify edges for regression testing.
                </div>

                <button
                  className="btn primary"
                  style={{ padding: 10, fontSize: 11, background: '#1a365d', borderColor: '#3182ce', color: '#63b3ed' }}
                  disabled={!detectedPiece}
                  onClick={handleFreezeGroundTruth}
                >
                  START LABELING [SPACE]
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  Drag <b>cyan pins (C1..C4)</b> on preview or click a corner below to reposition:
                </div>

                {/* Corner Coordinates & Reposition Controls */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, background: '#161b22', padding: 6, borderRadius: 4, border: '1px solid var(--border)' }}>
                  {gtCorners && gtCorners.map((pt, i) => (
                    <div
                      key={i}
                      onClick={() => setDraggingGtCorner(draggingGtCorner === i ? null : i)}
                      style={{
                        padding: '4px 6px',
                        background: draggingGtCorner === i ? '#00e5ff22' : '#21262d',
                        border: `1px solid ${draggingGtCorner === i ? '#00e5ff' : 'var(--border)'}`,
                        borderRadius: 3,
                        cursor: 'pointer',
                        fontSize: 9,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                      title={`Click to place C${i + 1}`}
                    >
                      <b style={{ color: draggingGtCorner === i ? '#00e5ff' : 'var(--text)' }}>C{i + 1}</b>
                      <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>({pt.x.toFixed(0)}, {pt.y.toFixed(0)})</span>
                    </div>
                  ))}
                </div>

                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  Set true physical edge characteristics:
                </div>

                <div className="gt-edge-list">
                  {gtEdges.map((type, idx) => (
                    <div key={idx} className={`gt-edge-item ${type.toLowerCase()}`}>
                      <span className="gt-edge-label">Edge {idx + 1} (C{idx + 1}→C{((idx + 1) % 4) + 1}):</span>
                      <div className="gt-edge-toggle">
                        {(['Tab', 'Hole', 'Flat'] as const).map((t) => (
                          <button
                            key={t}
                            className={`gt-edge-btn ${type === t ? `active ${t.toLowerCase()}` : ''}`}
                            onClick={() => handleToggleEdgeType(idx, t)}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="data-row" style={{ marginTop: 2, padding: '2px 4px' }}>
                  <span className="data-label">VERIFIED TYPE:</span>
                  <b style={{
                    color: gtEdges.filter(t => t === 'Flat').length >= 2 ? 'var(--red)' :
                      gtEdges.filter(t => t === 'Flat').length === 1 ? 'var(--yellow)' : 'var(--green)'
                  }}>
                    {gtEdges.filter(t => t === 'Flat').length >= 2 ? 'CORNER' :
                      gtEdges.filter(t => t === 'Flat').length === 1 ? 'BORDER' : 'INTERIOR'}
                  </b>
                </div>

                {gtSaveStatus && (
                  <div style={{ fontSize: 10, textAlign: 'center', color: gtSaveStatus.startsWith('✓') ? '#38a169' : '#e53e3e' }}>
                    {gtSaveStatus}
                  </div>
                )}

                <div className="gt-actions" style={{ marginTop: 8 }}>
                  <button className="btn" onClick={handleExitGtMode}>
                    CANCEL [ESC]
                  </button>
                  <button className="btn primary" onClick={handleSaveGroundTruth}>
                    SAVE [SPACE]
                  </button>
                </div>
              </div>
            )}
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
