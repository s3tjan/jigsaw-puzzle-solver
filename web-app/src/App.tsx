import { useEffect, useRef, useState, useCallback } from 'react'
import init, {
  greet,
  process_frame,
  dewarp_quad,
  snap_fiducial_corner,
  auto_detect_mat_quad,
  measure_stage_focus,
  analyze_staged_piece,
  compute_inverse_homography,
  auto_calibrate_lens_k1,
  WasmPuzzleBoard,
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

interface FrameAnalysis {
  width: number
  height: number
  avg_brightness: number
  elapsed_ms: number
}

const STORAGE_KEY = 'jigsaw_calibration_corners_v2'

const DEFAULT_CORNERS: [Point2D, Point2D, Point2D, Point2D] = [
  { x: 230, y: 75 },
  { x: 490, y: 75 },
  { x: 490, y: 335 },
  { x: 230, y: 335 },
]

function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [fps, setFps] = useState(0)
  const [stats, setStats] = useState<FrameAnalysis | null>(null)
  const [autoDewarp, setAutoDewarp] = useState(true)
  const [snappedIndex, setSnappedIndex] = useState<number | null>(null)
  const [focusScore, setFocusScore] = useState<number>(0)
  const [detectedPiece, setDetectedPiece] = useState<ScannedPiece | null>(null)
  const [stagedHistory, setStagedHistory] = useState<ScannedPiece[]>([])
  const [autoCaptureNotice, setAutoCaptureNotice] = useState<string | null>(null)

  // Problem 1: Lens Radial Distortion (k1)
  const [lensDistortion, setLensDistortion] = useState<number>(0.0)
  const [showCalibrationGuides, setShowCalibrationGuides] = useState<boolean>(true)
  const [showArOverlay, setShowArOverlay] = useState<boolean>(true)


  // Problem 2 & 4: Background delta segmentation sensitivity
  const [segSensitivity, setSegSensitivity] = useState<number>(24.0)

  // Visual inspection view mode ('dewarped' | 'binary' | 'composite')
  const [viewMode, setViewMode] = useState<'dewarped' | 'binary' | 'composite'>('composite')
  // Optical Sensor Rig display mode: 'camera' (full camera) vs 'dewarp' (magnified 1:1 piece)
  const [rigDisplayMode, setRigDisplayMode] = useState<'camera' | 'dewarp'>('camera')
  // Puzzle box artwork opacity (0.1 to 1.0)
  const [boxArtOpacity, setBoxArtOpacity] = useState<number>(0.75)

  // Diagnostics snapshot info
  const [latestAnalysis, setLatestAnalysis] = useState<any>(null)
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null)

  // Assembly Puzzle Board Solver state (1000 pieces: 40 cols x 25 rows placeholder)
  const boardRef = useRef<WasmPuzzleBoard | null>(null)
  const [candidateSlots, setCandidateSlots] = useState<any[]>([])
  const [boardSlots, setBoardSlots] = useState<any[]>([])
  const [boxArtUrl, setBoxArtUrl] = useState<string | null>(null)
  const boxArtInputRef = useRef<HTMLInputElement>(null)



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
  const rigDewarpedCanvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameIdRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(performance.now())
  const frameCountRef = useRef<number>(0)
  const latestPixelsRef = useRef<{ bytes: Uint8Array; w: number; h: number } | null>(null)
  const latestDewarpedRef = useRef<{ bytes: Uint8Array; w: number; h: number } | null>(null)
  const latestBinaryMaskRef = useRef<Uint8Array | null>(null)

  // Motion debouncing & hands-free auto-capture state
  const steadySinceRef = useRef<number | null>(null)
  const lastCenterRef = useRef<Point2D | null>(null)
  const hasCapturedRef = useRef<boolean>(false)
  const isAwaitingPieceRemovalRef = useRef<boolean>(false)
  const frameDimsRef = useRef<{ w: number; h: number }>({ w: 960, h: 540 })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(corners))
    } catch { }
  }, [corners])

  useEffect(() => {
    init()
      .then(() => {
        setWasmReady(true)
        greet('Puzzle Master')
        try {
          // Initialize 1000-piece board (25 rows x 40 cols = 1000 pieces)
          const newBoard = new WasmPuzzleBoard(25, 40)
          boardRef.current = newBoard
          const initialSlots = newBoard.get_slots_json()
          setBoardSlots(initialSlots || [])
        } catch (e) {
          console.error('Failed to init WasmPuzzleBoard:', e)
        }
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

  // Helper to map straight planar point to distorted camera coordinates
  const distortPt = (x: number, y: number, w: number, h: number, k1: number): Point2D => {
    if (Math.abs(k1) <= 1e-4) return { x, y }
    const cx = w * 0.5
    const cy = h * 0.5
    const diag = Math.hypot(cx, cy)
    const normX = (x - cx) / diag
    const normY = (y - cy) / diag
    const r2 = normX * normX + normY * normY
    const factor = 1.0 + k1 * r2
    return {
      x: cx + normX * factor * diag,
      y: cy + normY * factor * diag,
    }
  }

  // Helper to undistort camera coordinate back to rectilinear plane
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

  const drawOverlay = (
    w: number,
    h: number,
    pts: [Point2D, Point2D, Point2D, Point2D],
    showGuides: boolean,
    showAr: boolean,
    lensK1: number,
    piece: ScannedPiece | null
  ) => {
    const overlay = overlayCanvasRef.current
    const video = videoRef.current
    if (!overlay) return
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w
      overlay.height = h
    }

    // Align overlay canvas exact bounding box to match the displayed video element letterbox
    if (video && video.clientWidth > 0 && video.clientHeight > 0) {
      const vWidth = video.clientWidth
      const vHeight = video.clientHeight
      if (overlay.style.width !== `${vWidth}px`) {
        overlay.style.width = `${vWidth}px`
        overlay.style.height = `${vHeight}px`
      }
    }

    const ctx = overlay.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, w, h)

    if (showGuides) {
      // 1. Convert current 4 corner fiducial coordinates to undistorted rectilinear space
      const unTL = undistortPt(pts[0].x, pts[0].y, w, h, lensK1)
      const unTR = undistortPt(pts[1].x, pts[1].y, w, h, lensK1)
      const unBR = undistortPt(pts[2].x, pts[2].y, w, h, lensK1)
      const unBL = undistortPt(pts[3].x, pts[3].y, w, h, lensK1)

      const centerRect = {
        x: (unTL.x + unTR.x + unBR.x + unBL.x) * 0.25,
        y: (unTL.y + unTR.y + unBR.y + unBL.y) * 0.25,
      }

      const expandFromCenter = (p: Point2D, ratio: number): Point2D => ({
        x: centerRect.x + (p.x - centerRect.x) * ratio,
        y: centerRect.y + (p.y - centerRect.y) * ratio,
      })

      // Inner piece staging box: 40.00 mm on 60.00 mm fiducial square (ratio 40 / 60 = 0.6667)
      const stagingTL = expandFromCenter(unTL, 40.0 / 60.0)
      const stagingTR = expandFromCenter(unTR, 40.0 / 60.0)
      const stagingBR = expandFromCenter(unBR, 40.0 / 60.0)
      const stagingBL = expandFromCenter(unBL, 40.0 / 60.0)

      // Draw curved polygon sampling straight line in rectified plane and projecting through lens distortion
      const drawCurvedPolygon = (
        quadCorners: [Point2D, Point2D, Point2D, Point2D],
        strokeColor: string,
        lineWidth: number,
        dash: number[] = [],
        fillColor?: string
      ) => {
        ctx.beginPath()
        ctx.setLineDash(dash)
        ctx.strokeStyle = strokeColor
        ctx.lineWidth = lineWidth

        const SAMPLES_PER_EDGE = 24
        for (let side = 0; side < 4; side++) {
          const pStart = quadCorners[side]
          const pEnd = quadCorners[(side + 1) % 4]
          for (let step = 0; step <= SAMPLES_PER_EDGE; step++) {
            const t = step / SAMPLES_PER_EDGE
            const interpX = pStart.x + (pEnd.x - pStart.x) * t
            const interpY = pStart.y + (pEnd.y - pStart.y) * t
            const distPt = distortPt(interpX, interpY, w, h, lensK1)
            if (side === 0 && step === 0) {
              ctx.moveTo(distPt.x, distPt.y)
            } else {
              ctx.lineTo(distPt.x, distPt.y)
            }
          }
        }
        ctx.closePath()
        if (fillColor) {
          ctx.fillStyle = fillColor
          ctx.fill()
        }
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Draw Main 48.00mm Sovereign ArUco Perimeter Guide (High-contrast Neon Cyan outline)
      drawCurvedPolygon([unTL, unTR, unBR, unBL], '#00e5ff', 2.2, [6, 4], 'rgba(0, 229, 255, 0.05)')

      // Draw Inner Staging Boundary (35mm piece placement area, Vivid Emerald dashed)
      drawCurvedPolygon([stagingTL, stagingTR, stagingBR, stagingBL], '#00e676', 1.8, [4, 4], 'rgba(0, 230, 118, 0.04)')

      // Digital Center Crosshair HUD on the live video feed (High visibility cyan reticle with contrast backing)
      const cDist = distortPt(centerRect.x, centerRect.y, w, h, lensK1)
      ctx.beginPath()
      ctx.strokeStyle = '#00e5ff'
      ctx.lineWidth = 1.8
      ctx.shadowColor = '#000000'
      ctx.shadowBlur = 3
      // Crosshair with open center
      ctx.moveTo(cDist.x - 18, cDist.y)
      ctx.lineTo(cDist.x - 4, cDist.y)
      ctx.moveTo(cDist.x + 4, cDist.y)
      ctx.lineTo(cDist.x + 18, cDist.y)
      ctx.moveTo(cDist.x, cDist.y - 18)
      ctx.lineTo(cDist.x, cDist.y - 4)
      ctx.moveTo(cDist.x, cDist.y + 4)
      ctx.lineTo(cDist.x, cDist.y + 18)
      ctx.stroke()
      ctx.shadowBlur = 0

      // Diagnostic guide label with dark badge backing
      const topLabelPt = distortPt(
        (unTL.x + unTR.x) * 0.5,
        unTL.y - 10,
        w,
        h,
        lensK1
      )
      const guideText = `48mm ARUCO BENCH (k1=${lensK1.toFixed(2)})`
      ctx.font = 'bold 10px monospace'
      const textWidth = ctx.measureText(guideText).width
      ctx.fillStyle = 'rgba(15, 18, 23, 0.85)'
      ctx.fillRect(topLabelPt.x - textWidth / 2 - 4, topLabelPt.y - 9, textWidth + 8, 14)
      ctx.fillStyle = '#00e5ff'
      ctx.fillText(guideText, topLabelPt.x - textWidth / 2, topLabelPt.y + 2)
    }

    // Draw the 4 interactive draggable corner handles on the fiducials
    // If guides are turned off, we also hide the handles unless actively dragging
    if (showGuides || draggingIdx !== null) {
      // Draw Optical Center Alignment Reticle between the 4 corners
      const centerMatX = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) * 0.25
      const centerMatY = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) * 0.25

      ctx.save()
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.65)'
      ctx.lineWidth = 1.0
      ctx.setLineDash([2, 2])
      // Center crosshair
      ctx.beginPath()
      ctx.moveTo(centerMatX - 16, centerMatY)
      ctx.lineTo(centerMatX + 16, centerMatY)
      ctx.moveTo(centerMatX, centerMatY - 16)
      ctx.lineTo(centerMatX, centerMatY + 16)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(centerMatX, centerMatY, 6, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      const labels = ['P0: TL', 'P1: TR', 'P2: BR', 'P3: BL']
      pts.forEach((pt, i) => {
        const isDragging = i === draggingIdx
        const isSnapped = i === snappedIndex
        const activeColor = isDragging ? '#ff9100' : isSnapped ? '#00e676' : '#00e5ff'

        // CV Search Basin Circle (radius ~32px showing auto-snap search radius)
        ctx.save()
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, 32, 0, Math.PI * 2)
        ctx.strokeStyle = isSnapped ? 'rgba(0, 230, 118, 0.45)' : 'rgba(0, 229, 255, 0.25)'
        ctx.lineWidth = 1.0
        ctx.setLineDash([3, 3])
        ctx.stroke()
        ctx.restore()

        // Outer ring
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, 14, 0, Math.PI * 2)
        ctx.strokeStyle = activeColor
        ctx.lineWidth = isDragging ? 2.5 : 1.5
        ctx.stroke()

        // Inner clear center punch (radius 3px, unshaded transparent hole)
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2)
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.2
        ctx.stroke()

        // Reticle Crosshairs with central gap (leaving fiducial center unobstructed)
        ctx.beginPath()
        ctx.strokeStyle = activeColor
        ctx.lineWidth = 1.2
        ctx.moveTo(pt.x - 18, pt.y)
        ctx.lineTo(pt.x - 5, pt.y)
        ctx.moveTo(pt.x + 5, pt.y)
        ctx.lineTo(pt.x + 18, pt.y)
        ctx.moveTo(pt.x, pt.y - 18)
        ctx.lineTo(pt.x, pt.y - 5)
        ctx.moveTo(pt.x, pt.y + 5)
        ctx.lineTo(pt.x, pt.y + 18)
        ctx.stroke()

        // Text label with subtle dark backdrop for legibility
        ctx.font = 'bold 9px monospace'
        const labelText = labels[i]
        const textWidth = ctx.measureText(labelText).width
        ctx.fillStyle = 'rgba(10, 13, 17, 0.75)'
        ctx.fillRect(pt.x + 16, pt.y - 7, textWidth + 6, 13)
        ctx.fillStyle = '#ffffff'
        ctx.fillText(labelText, pt.x + 19, pt.y + 3)
      })
    }

    // IN-SITU AUGMENTED REALITY PIECE OVERLAY (Rendered directly over the physical piece)
    if (piece && piece.contour_points.length > 0 && showAr) {
      try {
        // Map dewarped contour points back to video coordinates using inverse homography
        const invH = compute_inverse_homography(
          pts[0].x, pts[0].y,
          pts[1].x, pts[1].y,
          pts[2].x, pts[2].y,
          pts[3].x, pts[3].y,
          384, 384,
          w, h,
          lensK1
        )

        if (invH && invH.length === 9) {
          const mapStageToVideo = (px: number, py: number): Point2D => {
            const denom = invH[6] * px + invH[7] * py + invH[8]
            if (Math.abs(denom) < 1e-9) return { x: 0, y: 0 }
            const inv_d = 1.0 / denom
            const unX = (invH[0] * px + invH[1] * py + invH[2]) * inv_d
            const unY = (invH[3] * px + invH[4] * py + invH[5]) * inv_d
            return distortPt(unX, unY, w, h, lensK1)
          }

          // A. Draw Neon Green Augmented Boundary
          ctx.beginPath()
          const firstPt = mapStageToVideo(piece.contour_points[0].x, piece.contour_points[0].y)
          ctx.moveTo(firstPt.x, firstPt.y)
          for (let i = 1; i < piece.contour_points.length; i++) {
            const vidPt = mapStageToVideo(piece.contour_points[i].x, piece.contour_points[i].y)
            ctx.lineTo(vidPt.x, vidPt.y)
          }
          ctx.closePath()
          ctx.strokeStyle = '#00e676'
          ctx.lineWidth = 2.0
          ctx.shadowColor = '#00e676'
          ctx.shadowBlur = 6
          ctx.stroke()
          ctx.fillStyle = 'rgba(0, 230, 118, 0.08)'
          ctx.fill()
          ctx.shadowBlur = 0

          // B. Draw Piece Corners (C0..C3)
          piece.corners.forEach((cPt, i) => {
            const vidCorner = mapStageToVideo(cPt.x, cPt.y)
            ctx.beginPath()
            ctx.arc(vidCorner.x, vidCorner.y, 4, 0, Math.PI * 2)
            ctx.fillStyle = '#ff3d00'
            ctx.fill()
            ctx.strokeStyle = '#ffffff'
            ctx.lineWidth = 1.2
            ctx.stroke()
            ctx.fillStyle = '#ffffff'
            ctx.font = 'bold 9px monospace'
            ctx.fillText(`C${i}`, vidCorner.x + 5, vidCorner.y - 3)
          })
        }
      } catch (err) {
        // Prevent singular homography matrix from interrupting render loop
      }
    }
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
    } catch { }
  }

  // Refs to avoid rerunning useEffect/recreating processLoop on every state change
  const cornersRef = useRef(corners)
  cornersRef.current = corners
  const lensDistortionRef = useRef(lensDistortion)
  lensDistortionRef.current = lensDistortion
  const segSensitivityRef = useRef(segSensitivity)
  segSensitivityRef.current = segSensitivity
  const viewModeRef = useRef(viewMode)
  viewModeRef.current = viewMode
  const showCalibrationGuidesRef = useRef(showCalibrationGuides)
  showCalibrationGuidesRef.current = showCalibrationGuides
  const showArOverlayRef = useRef(showArOverlay)
  showArOverlayRef.current = showArOverlay
  const autoDewarpRef = useRef(autoDewarp)
  autoDewarpRef.current = autoDewarp
  const lastCvTimeRef = useRef<number>(0)
  const detectedPieceRef = useRef<ScannedPiece | null>(null)

  const processLoop = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const dewarpedCanvas = dewarpedCanvasRef.current
    const rigDewarpedCanvas = rigDewarpedCanvasRef.current

    if (video && canvas && video.readyState >= 2 && wasmReady) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        // Optimize CV processing resolution to 720p width (fast, highly accurate subpixel fiducials)
        const targetW = 720
        const targetH = Math.round((video.videoHeight / video.videoWidth) * targetW) || 405
        frameDimsRef.current = { w: targetW, h: targetH }

        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW
          canvas.height = targetH
        }

        ctx.drawImage(video, 0, 0, targetW, targetH)
        const imgData = ctx.getImageData(0, 0, targetW, targetH)

        const now = performance.now()
        // Throttle heavy Rust WASM CV analysis to ~6 times per second (every 160ms)
        // This keeps the frame rate locked at a buttery 60 FPS while keeping metrology snappy!
        const shouldRunCv = now - lastCvTimeRef.current >= 160

        try {
          const rawBytes = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength)
          latestPixelsRef.current = { bytes: rawBytes, w: targetW, h: targetH }

          if (shouldRunCv) {
            lastCvTimeRef.current = now

            const analysis: FrameAnalysis = process_frame(rawBytes, targetW, targetH)
            setStats(analysis)

            const curCorners = cornersRef.current
            const curK1 = lensDistortionRef.current
            const curSens = segSensitivityRef.current
            const curViewMode = viewModeRef.current

            // Measure high-frequency focus MTF on optical stage
            const mtf = measure_stage_focus(
              rawBytes,
              targetW,
              targetH,
              curCorners[0].x, curCorners[0].y,
              curCorners[1].x, curCorners[1].y,
              curCorners[2].x, curCorners[2].y,
              curCorners[3].x, curCorners[3].y
            )
            setFocusScore(mtf)

            if (autoDewarpRef.current && dewarpedCanvas) {
              const dstW = 384
              const dstH = 384
              if (dewarpedCanvas.width !== dstW || dewarpedCanvas.height !== dstH) {
                dewarpedCanvas.width = dstW
                dewarpedCanvas.height = dstH
              }

              let dewarpedBytes: Uint8Array | null = null
              let analysisResult: any = null
              let piece: ScannedPiece | null = null

              try {
                dewarpedBytes = dewarp_quad(
                  rawBytes,
                  targetW,
                  targetH,
                  curCorners[0].x, curCorners[0].y,
                  curCorners[1].x, curCorners[1].y,
                  curCorners[2].x, curCorners[2].y,
                  curCorners[3].x, curCorners[3].y,
                  dstW,
                  dstH,
                  curK1
                )
                latestDewarpedRef.current = { bytes: dewarpedBytes, w: dstW, h: dstH }

                // Run piece boundary contour segmentation
                analysisResult = analyze_staged_piece(dewarpedBytes, dstW, dstH, curSens)
                setLatestAnalysis(analysisResult)
                piece = analysisResult?.piece || null
                detectedPieceRef.current = piece
                setDetectedPiece(piece)

                if (analysisResult?.binary_mask) {
                  latestBinaryMaskRef.current = new Uint8Array(analysisResult.binary_mask)
                }
              } catch (cvErr) {
                // Safeguard against singular matrix or memory buffer panic
                console.warn('[CV] Frame processing skipped:', cvErr)
              }

              const dCtx = dewarpedCanvas.getContext('2d')
              if (dCtx && dewarpedBytes) {
                // Render staging canvas according to selected view mode
                const dewarpedImageData = dCtx.createImageData(dstW, dstH)
                if (curViewMode === 'binary' && analysisResult?.binary_mask) {
                  const mask = analysisResult.binary_mask
                  for (let i = 0; i < dstW * dstH; i++) {
                    const val = mask[i]
                    dewarpedImageData.data[i * 4] = val
                    dewarpedImageData.data[i * 4 + 1] = val
                    dewarpedImageData.data[i * 4 + 2] = val
                    dewarpedImageData.data[i * 4 + 3] = 255
                  }
                } else if (analysisResult?.binary_mask && (curViewMode === 'composite' || curViewMode === 'dewarped')) {
                  // Chroma-key green background: set alpha = 0 for background pixels
                  dewarpedImageData.data.set(dewarpedBytes)
                  const mask = analysisResult.binary_mask
                  for (let i = 0; i < dstW * dstH; i++) {
                    if (mask[i] === 0) {
                      dewarpedImageData.data[i * 4 + 3] = 0 // Transparent green mat background
                    }
                  }
                } else {
                  dewarpedImageData.data.set(dewarpedBytes)
                }
                dCtx.clearRect(0, 0, dstW, dstH)
                dCtx.putImageData(dewarpedImageData, 0, 0)

                if (piece && (curViewMode === 'composite' || curViewMode === 'dewarped')) {
                  drawPieceDiagnostics(dCtx, piece)
                }

                // If sensor rig preview canvas is mounted, mirror the cleanly cleared canvas
                if (rigDewarpedCanvas) {
                  if (rigDewarpedCanvas.width !== dstW || rigDewarpedCanvas.height !== dstH) {
                    rigDewarpedCanvas.width = dstW
                    rigDewarpedCanvas.height = dstH
                  }
                  const rCtx = rigDewarpedCanvas.getContext('2d')
                  if (rCtx) {
                    rCtx.clearRect(0, 0, dstW, dstH)
                    rCtx.drawImage(dewarpedCanvas, 0, 0)
                  }
                }

                if (piece && (curViewMode === 'composite' || curViewMode === 'dewarped')) {
                  // Hands-Free Auto-Capture Motion Debouncing:
                  if (lastCenterRef.current) {
                    const dist = Math.hypot(piece.center.x - lastCenterRef.current.x, piece.center.y - lastCenterRef.current.y)
                    if (isAwaitingPieceRemovalRef.current) {
                      // Piece was registered; do not capture again until piece is removed from view
                    } else if (dist < 3.0) {
                      if (steadySinceRef.current === null) {
                        steadySinceRef.current = now
                      } else if (now - steadySinceRef.current >= 600 && !hasCapturedRef.current) {
                        // Piece is completely steady: Auto-Capture once!
                        hasCapturedRef.current = true
                        isAwaitingPieceRemovalRef.current = true
                        registerPieceAndFindCandidates(piece)
                      }
                    } else {
                      // Moving hand or repositioning piece
                      steadySinceRef.current = null
                    }
                  }
                  lastCenterRef.current = piece.center
                } else {
                  // Arena completely empty or hand swapped piece: clear lockout so next piece can be registered
                  steadySinceRef.current = null
                  lastCenterRef.current = null
                  hasCapturedRef.current = false
                  isAwaitingPieceRemovalRef.current = false
                }
              }
            }
          }
        } catch (e) {
          console.error('Rust compute error:', e)
        }

        // Draw interactive HUD overlay smoothly on every frame (using current ref values)
        drawOverlay(
          targetW,
          targetH,
          cornersRef.current,
          showCalibrationGuidesRef.current,
          showArOverlayRef.current,
          lensDistortionRef.current,
          detectedPieceRef.current
        )

        frameCountRef.current += 1
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

  const registerPieceAndFindCandidates = (piece: ScannedPiece) => {
    playCaptureTone()
    setStagedHistory((prev) => [piece, ...prev.slice(0, 19)])
    setAutoCaptureNotice('PIECE REGISTERED')
    setTimeout(() => setAutoCaptureNotice(null), 1500)

    if (boardRef.current) {
      try {
        const matches = boardRef.current.find_candidates(piece)
        if (Array.isArray(matches) && matches.length > 0) {
          setCandidateSlots(matches)
          // If high confidence match, simulate placing first piece to show progress
          const best = matches[0]
          boardRef.current.place_piece(stagedHistory.length, piece, best.row, best.col, best.rotation)
          const updatedSlots = boardRef.current.get_slots_json()
          setBoardSlots(updatedSlots)
        } else {
          setCandidateSlots([])
        }
      } catch (err) {
        console.warn('Candidate search error:', err)
      }
    }
  }


  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const { w, h } = frameDimsRef.current
    const scaleX = w / rect.width
    const scaleY = h / rect.height
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
    const { w, h } = frameDimsRef.current
    const scaleX = w / rect.width
    const scaleY = h / rect.height
    const mx = Math.max(10, Math.min(w - 10, (e.clientX - rect.left) * scaleX))
    const my = Math.max(10, Math.min(h - 10, (e.clientY - rect.top) * scaleY))

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
      } catch { }
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

  const handleAutoSnapAllCorners = () => {
    if (latestPixelsRef.current && wasmReady) {
      try {
        const { bytes, w, h } = latestPixelsRef.current
        const detected = auto_detect_mat_quad(
          bytes,
          w,
          h,
          corners[0].x, corners[0].y,
          corners[1].x, corners[1].y,
          corners[2].x, corners[2].y,
          corners[3].x, corners[3].y
        )
        if (detected && detected.length >= 8) {
          setCorners([
            { x: detected[0], y: detected[1] },
            { x: detected[2], y: detected[3] },
            { x: detected[4], y: detected[5] },
            { x: detected[6], y: detected[7] },
          ])
          setSnappedIndex(99)
          setTimeout(() => setSnappedIndex(null), 1500)
        }
      } catch (err) {
        console.warn('Auto snap quad error:', err)
      }
    }
  }

  const handleAutoCalibrateK1 = () => {
    if (latestPixelsRef.current && wasmReady) {
      try {
        const { bytes, w, h } = latestPixelsRef.current
        const computedK1 = auto_calibrate_lens_k1(
          bytes,
          w,
          h,
          corners[0].x, corners[0].y,
          corners[1].x, corners[1].y,
          corners[2].x, corners[2].y,
          corners[3].x, corners[3].y
        )
        if (!isNaN(computedK1) && isFinite(computedK1)) {
          const rounded = Math.round(computedK1 * 100) / 100
          setLensDistortion(rounded)
          setSnappedIndex(99)
          setTimeout(() => setSnappedIndex(null), 1200)
        }
      } catch (err) {
        console.warn('Auto calibrate k1 error:', err)
      }
    }
  }

  const handleResetCorners = () => {
    const { w, h } = frameDimsRef.current
    if (w > 0 && h > 0) {
      const cx = w * 0.5
      const cy = h * 0.5
      // Bounded within camera frame so corners never fall outside viewport
      const halfSize = Math.min(w, h) * 0.32
      const centeredCorners: [Point2D, Point2D, Point2D, Point2D] = [
        { x: Math.round(cx - halfSize), y: Math.round(cy - halfSize) },
        { x: Math.round(cx + halfSize), y: Math.round(cy - halfSize) },
        { x: Math.round(cx + halfSize), y: Math.round(cy + halfSize) },
        { x: Math.round(cx - halfSize), y: Math.round(cy + halfSize) },
      ]
      setCorners(centeredCorners)
    } else {
      setCorners(DEFAULT_CORNERS)
    }
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch { }
  }

  const handleManualLockPiece = () => {
    if (detectedPiece) {
      registerPieceAndFindCandidates(detectedPiece)
    }
  }

  // Diagnostic snapshot exporter
  const handleSaveSnapshot = (includeImages: boolean = false) => {
    try {
      const now = new Date()
      const ts = now.toISOString().replace(/[:.]/g, '-')

      let rawDataUrl: string | null = null
      let dewarpedDataUrl: string | null = null
      let binaryDataUrl: string | null = null

      if (includeImages) {
        rawDataUrl = canvasRef.current?.toDataURL('image/png') || null
        dewarpedDataUrl = dewarpedCanvasRef.current?.toDataURL('image/png') || null

        if (latestBinaryMaskRef.current && latestDewarpedRef.current) {
          const maskCanvas = document.createElement('canvas')
          const mw = latestDewarpedRef.current.w
          const mh = latestDewarpedRef.current.h
          maskCanvas.width = mw
          maskCanvas.height = mh
          const mCtx = maskCanvas.getContext('2d')
          if (mCtx) {
            const imgData = mCtx.createImageData(mw, mh)
            const mask = latestBinaryMaskRef.current
            for (let i = 0; i < mw * mh; i++) {
              const v = mask[i]
              imgData.data[i * 4] = v
              imgData.data[i * 4 + 1] = v
              imgData.data[i * 4 + 2] = v
              imgData.data[i * 4 + 3] = 255
            }
            mCtx.putImageData(imgData, 0, 0)
            binaryDataUrl = maskCanvas.toDataURL('image/png')
          }
        }
      }

      const snapshotData = {
        timestamp: now.toISOString(),
        corners,
        lens_distortion_k1: lensDistortion,
        segmentation_sensitivity: segSensitivity,
        analysis_telemetry: latestAnalysis,
        detected_piece: detectedPiece,
        system_stats: stats,
        fps,
        ...(includeImages
          ? {
              images: {
                raw_frame: rawDataUrl,
                dewarped_stage: dewarpedDataUrl,
                binary_mask: binaryDataUrl,
              },
            }
          : {}),
      }

      // Download JSON bundle
      const blob = new Blob([JSON.stringify(snapshotData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = includeImages
        ? `cv-full-snapshot-${ts}.json`
        : `cv-metrics-${ts}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setSnapshotStatus(`SAVED: ${includeImages ? 'FULL' : 'METRICS'}`)
      setTimeout(() => setSnapshotStatus(null), 3000)
    } catch (err) {
      console.error('Snapshot failed:', err)
      setSnapshotStatus('ERROR SAVING')
      setTimeout(() => setSnapshotStatus(null), 3000)
    }
  }

  // Keyboard Hotkeys for streamlined hands-free metrology operation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is focused on an input
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
        return
      }

      if (e.code === 'Space') {
        e.preventDefault()
        if (detectedPiece) {
          registerPieceAndFindCandidates(detectedPiece)
        }
      } else if (e.key === 'a' || e.key === 'A') {
        handleAutoSnapAllCorners()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [detectedPiece])

  return (
    <div className="ind-app">
      {/* =================================================================== */}
      {/* 1. TOP METROLOGY STATUS HEADER (Fixed Height: 34px)                 */}
      {/* =================================================================== */}
      <header className="ind-header">
        <div className="ind-brand">
          <span>OPTICAL METROLOGY SYSTEM</span>
          <span className="ind-badge">48mm ARUCO</span>
        </div>

        <div className="ind-telemetry">
          <div className="ind-tel-item">
            <span className="ind-tel-label">STREAM:</span>
            <span className={`ind-tel-value ${isCameraActive ? 'green' : 'red'}`}>
              {isCameraActive ? `720P @ ${fps} FPS` : 'OFFLINE'}
            </span>
          </div>

          <div className="ind-tel-item">
            <span className="ind-tel-label">LENS K1:</span>
            <span className="ind-tel-value yellow">{lensDistortion.toFixed(2)}</span>
          </div>

          <div className="ind-tel-item">
            <span className="ind-tel-label">FOCUS MTF:</span>
            <span className={`ind-tel-value ${focusScore >= 45 ? 'green' : focusScore >= 20 ? 'yellow' : 'red'}`}>
              {focusScore.toFixed(0)}% {focusScore >= 45 ? 'SHARP' : focusScore >= 20 ? 'FAIR' : 'BLUR'}
            </span>
          </div>

          <div className="ind-tel-item">
            <span className="ind-tel-label">STAGE RGB:</span>
            <span className="ind-tel-value green">
              {latestAnalysis?.bg_mean_rgb
                ? `${latestAnalysis.bg_mean_rgb[0]},${latestAnalysis.bg_mean_rgb[1]},${latestAnalysis.bg_mean_rgb[2]}`
                : '--'}
            </span>
          </div>

          <div className="ind-tel-item">
            <span className="ind-tel-label">LATENCY:</span>
            <span className="ind-tel-value">
              {stats ? `${stats.elapsed_ms.toFixed(1)}ms` : '--'}
            </span>
          </div>
        </div>
      </header>

      {/* =================================================================== */}
      {/* 2. THREE-PANEL SPLIT MAIN VIEWPORT                                  */}
      {/* [1] ASSEMBLY SOLVER (Primary Left) | [2] RECTIFIED STAGING | [3] CAM RIG */}
      {/* =================================================================== */}
      <main className="ind-main-grid">
        {/* PANEL 1 (PRIMARY): Assembly Solver & Puzzle Board Grid */}
        <section className="ind-panel">
          <div className="ind-panel-titlebar">
            <span>[1] ASSEMBLY SOLVER (1000-PIECE BOARD)</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                className="ind-btn"
                style={{ height: '18px', padding: '0 6px', fontSize: '9px' }}
                onClick={() => boxArtInputRef.current?.click()}
                title="Load puzzle box artwork image (e.g. Van Gogh Starry Night)"
              >
                {boxArtUrl ? 'REPLACE ART' : 'LOAD BOX ART'}
              </button>
              {boxArtUrl && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ fontSize: '9px', color: 'var(--ind-text-muted)' }}>OPACITY:</span>
                    <input
                      type="range"
                      min="0.1"
                      max="1.0"
                      step="0.05"
                      value={boxArtOpacity}
                      onChange={(e) => setBoxArtOpacity(parseFloat(e.target.value))}
                      style={{ width: '60px', height: '4px', accentColor: 'var(--ind-blue)', cursor: 'pointer' }}
                      title="Adjust box artwork overlay opacity"
                    />
                    <span style={{ fontSize: '9px', color: 'var(--ind-yellow)', width: '26px' }}>
                      {Math.round(boxArtOpacity * 100)}%
                    </span>
                  </div>
                  <button
                    className="ind-btn"
                    style={{ height: '18px', padding: '0 5px', fontSize: '8px' }}
                    onClick={() => setBoxArtUrl(null)}
                    title="Remove artwork overlay"
                  >
                    CLEAR
                  </button>
                </>
              )}
              <input
                ref={boxArtInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) {
                    const url = URL.createObjectURL(file)
                    setBoxArtUrl(url)
                  }
                }}
              />
              <span style={{ color: 'var(--ind-blue)', fontWeight: 700 }}>
                {boardSlots.filter((s: any) => s.piece_id !== null && s.piece_id !== undefined).length} / 1000
              </span>
            </div>
          </div>

          <div className="ind-panel-body">
            <div className="ind-assembly-grid-container">
              {/* 1000-Piece Board Schematic (40 cols x 25 rows = 1000 slots) with artwork overlay */}
              <div className="ind-board-wrapper">
                {boxArtUrl && (
                  <div
                    className="ind-board-art-overlay"
                    style={{
                      backgroundImage: `url(${boxArtUrl})`,
                      opacity: boxArtOpacity
                    }}
                  />
                )}
                <div className="ind-grid-placeholder-board">
                  {Array.from({ length: 1000 }).map((_, i) => {
                    const r = Math.floor(i / 40)
                    const c = i % 40
                    const isBorder = r === 0 || r === 24 || c === 0 || c === 39
                    const isPlaced = i < stagedHistory.length
                    const isCandidate = candidateSlots.some((cs: any) => cs.row === r && cs.col === c)

                    return (
                      <div
                        key={i}
                        className={`ind-grid-cell ${isBorder ? 'border' : ''} ${isPlaced ? 'placed' : ''} ${isCandidate ? 'candidate' : ''}`}
                        title={`Slot (R${r}, C${c})${isPlaced ? ' [OCCUPIED]' : isCandidate ? ' [BEST MATCH]' : ''}`}
                      />
                    )
                  })}
                </div>
              </div>

              {/* Placement Match Candidate Cards */}
              <div className="ind-section">
                <div className="ind-section-title">Target Slot Matching</div>
                {candidateSlots.length === 0 ? (
                  <div style={{ color: 'var(--ind-text-dim)', fontSize: '10px', padding: '4px 0' }}>
                    {detectedPiece
                      ? 'Ready to match piece shape against neighboring board contours.'
                      : 'Stage a puzzle piece to compute location on the 1000-piece grid.'}
                  </div>
                ) : (
                  candidateSlots.slice(0, 3).map((cand: any, idx: number) => (
                    <div key={idx} className="ind-row" style={{ fontSize: '10px' }}>
                      <span style={{ color: 'var(--ind-blue)', fontWeight: 700 }}>
                        RANK #{idx + 1}: ROW {cand.row}, COL {cand.col} (ROT: {cand.rotation * 90}°)
                      </span>
                      <span style={{ color: 'var(--ind-green)', fontWeight: 700 }}>
                        {(cand.score * 100).toFixed(0)}% MATCH
                      </span>
                    </div>
                  ))
                )}
              </div>

              {/* Scanned Inventory History */}
              <div className="ind-section" style={{ maxHeight: '140px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="ind-section-title">Scanned Pieces ({stagedHistory.length})</div>
                  {stagedHistory.length > 0 && (
                    <button
                      className="ind-btn"
                      onClick={() => setStagedHistory([])}
                      style={{ padding: '0 4px', height: '16px', fontSize: '8px' }}
                    >
                      CLEAR
                    </button>
                  )}
                </div>

                <div className="ind-inventory-list">
                  {stagedHistory.length === 0 ? (
                    <div style={{ color: 'var(--ind-text-dim)', fontSize: '9px' }}>
                      No pieces scanned in this session.
                    </div>
                  ) : (
                    stagedHistory.map((p, i) => (
                      <div key={i} className="ind-inventory-item">
                        <span>#{stagedHistory.length - i} ({(p.bounding_width * 0.156).toFixed(0)}×{(p.bounding_height * 0.156).toFixed(0)}mm)</span>
                        <span style={{
                          fontWeight: 700,
                          color: p.is_corner ? 'var(--ind-red)' : p.is_border ? 'var(--ind-yellow)' : 'var(--ind-green)'
                        }}>
                          {p.is_corner ? 'CORNER' : p.is_border ? 'BORDER' : 'INTERIOR'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Optical Sensor Rig (Top) & Rectified Staging Metrology (Bottom) */}
        <div className="ind-right-col">
          {/* TOP SUBPANEL: Optical Camera Sensor Rig (Align mat / fiducials at start of session) */}
          <section className="ind-panel">
            <div className="ind-panel-titlebar">
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span>[2] OPTICAL SENSOR RIG</span>
                <span style={{ color: 'var(--ind-text-dim)' }}>48mm MAT</span>
              </div>
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <button
                  className={`ind-btn ${rigDisplayMode === 'camera' ? 'active' : ''}`}
                  onClick={() => setRigDisplayMode('camera')}
                  style={{ height: '18px', padding: '0 6px', fontSize: '9px' }}
                >
                  CAMERA
                </button>
                <button
                  className={`ind-btn ${rigDisplayMode === 'dewarp' ? 'active' : ''}`}
                  onClick={() => setRigDisplayMode('dewarp')}
                  style={{ height: '18px', padding: '0 6px', fontSize: '9px' }}
                >
                  1:1 DEWARP
                </button>
              </div>
            </div>

            <div className="ind-stage-viewport">
              {/* RAW CAMERA VIEW + AR RETICLE OVERLAY */}
              <video
                ref={videoRef}
                playsInline
                muted
                className="ind-camera-video"
                style={{ display: isCameraActive && rigDisplayMode === 'camera' ? 'block' : 'none' }}
              />
              <canvas ref={canvasRef} style={{ display: 'none' }} />
              {isCameraActive && rigDisplayMode === 'camera' && (
                <canvas
                  ref={overlayCanvasRef}
                  className="ind-stage-canvas"
                  style={{ cursor: draggingIdx !== null ? 'grabbing' : 'crosshair' }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                />
              )}

              {/* FULL 1:1 DEWARPED MODE IN SENSOR RIG */}
              {rigDisplayMode === 'dewarp' && (
                <div className="ind-rig-full-dewarp">
                  <div className="ind-dewarp-box" style={{ maxWidth: '340px' }}>
                    {/* Canvas displaying 1:1 rectified staging plane */}
                    <canvas ref={rigDewarpedCanvasRef} className="ind-dewarp-canvas" width={384} height={384} />
                  </div>
                  <div style={{ marginTop: '8px', color: 'var(--ind-text-muted)', fontSize: '10px' }}>
                    1:1 RECTIFIED STAGING PLANE (48mm CALIBRATED)
                  </div>
                </div>
              )}

              {!isCameraActive && (
                <div className="ind-stage-offline">
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--ind-text)' }}>
                    CAMERA OFFLINE
                  </span>
                  <span style={{ fontSize: '10px' }}>
                    {cameraError || 'Align mat at start of session.'}
                  </span>
                  <button className="ind-btn primary" onClick={startCamera} disabled={!wasmReady}>
                    ACTIVATE CAMERA
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* BOTTOM SUBPANEL: Rectified Staging & Edge Metrology */}
          {/* BOTTOM SUBPANEL: Piece Telemetry (Left) & Optical Calibration (Right) */}
          <section className="ind-panel">
            <div className="ind-panel-titlebar">
              <span>[3] PIECE METROLOGY & OPTICAL CALIBRATION</span>
              <span style={{ color: detectedPiece ? 'var(--ind-green)' : 'var(--ind-text-dim)' }}>
                {detectedPiece ? 'PIECE DETECTED' : 'READY'}
              </span>
            </div>

            {/* Hidden canvas so CV segmentation engine pipeline continues uninterrupted */}
            <canvas ref={dewarpedCanvasRef} style={{ display: 'none' }} width={384} height={384} />

            <div className="ind-panel-body ind-staging-split">
              {/* LEFT COLUMN: Piece Telemetry */}
              <div className="ind-staging-col">
                <div className="ind-section">
                  <div className="ind-section-title">Piece Telemetry</div>
                  <div className="ind-row">
                    <span className="ind-label">CLASSIFICATION:</span>
                    <span className="ind-val" style={{
                      color: detectedPiece
                        ? detectedPiece.is_corner ? 'var(--ind-red)' : detectedPiece.is_border ? 'var(--ind-yellow)' : 'var(--ind-green)'
                        : 'var(--ind-text-muted)'
                    }}>
                      {detectedPiece
                        ? (detectedPiece.is_corner ? 'CORNER' : detectedPiece.is_border ? 'BORDER' : 'INTERIOR')
                        : 'NO TARGET'}
                    </span>
                  </div>

                  <div className="ind-row">
                    <span className="ind-label">TRUE DIMENSIONS:</span>
                    <span className="ind-val">
                      {detectedPiece
                        ? `${(detectedPiece.bounding_width * 0.156).toFixed(1)} × ${(detectedPiece.bounding_height * 0.156).toFixed(1)} mm`
                        : '--'}
                    </span>
                  </div>

                  <div className="ind-row">
                    <span className="ind-label">ROTATION:</span>
                    <span className="ind-val">
                      {detectedPiece ? `${((detectedPiece.rotation_angle_rad * 180) / Math.PI).toFixed(1)}°` : '--'}
                    </span>
                  </div>

                  <div className="ind-row" style={{ marginTop: '2px' }}>
                    <span className="ind-label">EDGES:</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {detectedPiece ? (
                        detectedPiece.edges.map((e, idx) => (
                          <span
                            key={idx}
                            className={`ind-edge-pill ${e.edge_type === 'Tab' ? 'ind-edge-tab' : e.edge_type === 'Hole' ? 'ind-edge-hole' : 'ind-edge-flat'}`}
                          >
                            E{idx}:{e.edge_type[0]}
                          </span>
                        ))
                      ) : (
                        <span style={{ color: 'var(--ind-text-dim)', fontSize: '9px' }}>--</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN: Optical Calibration */}
              <div className="ind-staging-col">
                <div className="ind-section">
                  <div className="ind-section-title">Optical Calibration</div>
                  <div className="ind-row">
                    <span className="ind-label" style={{ width: '80px' }}>LENS K1:</span>
                    <input
                      type="range"
                      min="-0.5"
                      max="0.5"
                      step="0.01"
                      value={lensDistortion}
                      onChange={(e) => setLensDistortion(parseFloat(e.target.value))}
                      className="ind-slider"
                    />
                    <code style={{ width: '32px', textAlign: 'right', color: 'var(--ind-yellow)' }}>
                      {lensDistortion.toFixed(2)}
                    </code>
                    <button
                      className="ind-btn"
                      onClick={() => setLensDistortion(0.0)}
                      title="Reset Lens k1 distortion to 0.0"
                      style={{ padding: '0 5px', height: '18px', fontSize: '9px' }}
                    >
                      0
                    </button>
                    <button
                      className="ind-btn"
                      onClick={handleAutoCalibrateK1}
                      title="Auto-calculate lens distortion k1 using straight mat borders"
                      style={{ padding: '0 6px', height: '18px', fontSize: '8px', color: 'var(--ind-cyan)', borderColor: 'var(--ind-cyan)' }}
                    >
                      AUTO-CAL K1
                    </button>
                  </div>

                  <div className="ind-row">
                    <span className="ind-label" style={{ width: '80px' }}>SENSITIVITY:</span>
                    <input
                      type="range"
                      min="12"
                      max="60"
                      step="1"
                      value={segSensitivity}
                      onChange={(e) => setSegSensitivity(parseFloat(e.target.value))}
                      className="ind-slider"
                    />
                    <code style={{ width: '32px', textAlign: 'right' }}>
                      {segSensitivity.toFixed(0)}
                    </code>
                  </div>

                  {/* MTF Focus Live Indicator Bar */}
                  <div className="ind-row">
                    <span className="ind-label" style={{ width: '80px' }}>FOCUS MTF:</span>
                    <div style={{ flex: 1, height: '8px', background: '#1c2128', borderRadius: '2px', overflow: 'hidden', border: '1px solid #30363d' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${Math.min(100, Math.max(0, focusScore))}%`,
                          backgroundColor: focusScore >= 45 ? '#2ea043' : focusScore >= 20 ? '#d29922' : '#f85149',
                          transition: 'width 0.15s ease'
                        }}
                      />
                    </div>
                    <code style={{ width: '36px', textAlign: 'right', color: focusScore >= 45 ? '#2ea043' : focusScore >= 20 ? '#d29922' : '#f85149' }}>
                      {focusScore.toFixed(0)}%
                    </code>
                  </div>

                  <div className="ind-row">
                    <span className="ind-label">VIEW MODE:</span>
                    <div style={{ display: 'flex', gap: '3px' }}>
                      {(['composite', 'binary', 'dewarped'] as const).map((m) => (
                        <button
                          key={m}
                          className={`ind-btn ${viewMode === m ? 'active' : ''}`}
                          onClick={() => setViewMode(m)}
                          style={{ padding: '0 5px', height: '18px', fontSize: '8px' }}
                        >
                          {m.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* =================================================================== */}
      {/* 3. ORDERLY BOTTOM COMMAND BAR (Fixed Height: 38px)                  */}
      {/* =================================================================== */}
      <footer className="ind-bottom-bar">
        <div className="ind-actions-group">
          {isCameraActive ? (
            <button className="ind-btn" onClick={stopCamera}>
              STOP STREAM
            </button>
          ) : (
            <button className="ind-btn primary" onClick={startCamera}>
              START STREAM
            </button>
          )}

          <button
            className="ind-btn active"
            onClick={handleAutoSnapAllCorners}
            title="Auto-snap all 4 fiducials (Hotkey: A)"
          >
            AUTO-SNAP [A]
          </button>

          <button
            className={`ind-btn ${autoDewarp ? 'active' : ''}`}
            onClick={() => setAutoDewarp(!autoDewarp)}
          >
            DEWARP: {autoDewarp ? 'ON' : 'OFF'}
          </button>

          <button
            className={`ind-btn ${showCalibrationGuides ? 'active' : ''}`}
            onClick={() => setShowCalibrationGuides(!showCalibrationGuides)}
            title="Toggle Calibration Reticle & Grid Guides"
          >
            GUIDES: {showCalibrationGuides ? 'ON' : 'OFF'}
          </button>

          <button
            className={`ind-btn ${showArOverlay ? 'active' : ''}`}
            onClick={() => setShowArOverlay(!showArOverlay)}
            title="Toggle Augmented Reality Piece Boundary & Corners in Camera Stream"
          >
            AR: {showArOverlay ? 'ON' : 'OFF'}
          </button>

          <button
            className="ind-btn"
            onClick={handleResetCorners}
            title="Reset fiducial coordinates"
          >
            RESET MAT
          </button>

          <button
            className="ind-btn primary"
            onClick={handleManualLockPiece}
            disabled={!detectedPiece}
            title="Record Piece (Hotkey: Spacebar)"
          >
            RECORD PIECE [SPACE] ({stagedHistory.length})
          </button>
        </div>

        <div className="ind-actions-group">
          <button className="ind-btn" onClick={() => handleSaveSnapshot(false)}>
            SAVE METRICS
          </button>

          <button className="ind-btn" onClick={() => handleSaveSnapshot(true)}>
            SNAPSHOT
          </button>

          <a
            href={`/calibration_mat.svg?t=${Date.now()}`}
            download="optical_calibration_target_48mm.svg"
            className="ind-btn yellow"
            title="Download 1:1 scale Optical Calibration Target (48mm ArUco, Chroma Green)"
          >
            PRINT MAT (48mm)
          </a>

          <div className="ind-cmd-status">
            <span style={{ color: 'var(--ind-blue)', fontWeight: 700 }}>STATUS:</span>
            <span>
              {snapshotStatus
                ? snapshotStatus
                : autoCaptureNotice
                ? autoCaptureNotice
                : snappedIndex !== null
                ? 'FIDUCIAL LOCKED'
                : detectedPiece
                ? 'PIECE STAGED'
                : 'READY'}
            </span>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App

