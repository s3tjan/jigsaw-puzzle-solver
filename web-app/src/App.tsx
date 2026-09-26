import { useEffect, useRef, useState, useCallback } from 'react'
import init, { greet, process_frame, dewarp_quad, snap_fiducial_corner, analyze_staged_piece, WasmPuzzleBoard } from './pkg/cv_engine'
import { BoardView } from './components/BoardView'
import type { BoardSlot, SlotCandidate } from './components/BoardView'
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
  { x: 280, y: 90 },
  { x: 640, y: 90 },
  { x: 640, y: 440 },
  { x: 280, y: 440 },
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

  // Problem 1: Lens Radial Distortion (k1)
  const [lensDistortion, setLensDistortion] = useState<number>(0.0)
  const [showCalibrationGuides, setShowCalibrationGuides] = useState<boolean>(true)


  // Problem 2 & 4: Background delta segmentation sensitivity
  const [segSensitivity, setSegSensitivity] = useState<number>(24.0)

  // Problem 4 & 5: Visual inspection view mode ('dewarped' | 'binary' | 'composite')
  const [viewMode, setViewMode] = useState<'dewarped' | 'binary' | 'composite'>('composite')

  // Problem 5: Diagnostics snapshot info
  const [latestAnalysis, setLatestAnalysis] = useState<any>(null)
  const [snapshotStatus, setSnapshotStatus] = useState<string | null>(null)

  // Pillar 4: Assembly Board Graph State
  const boardRef = useRef<WasmPuzzleBoard | null>(null)
  const [boardSlots, setBoardSlots] = useState<BoardSlot[]>([])
  const [slotCandidates, setSlotCandidates] = useState<SlotCandidate[]>([])
  const [selectedCandidate, setSelectedCandidate] = useState<SlotCandidate | null>(null)
  const BOARD_ROWS = 10
  const BOARD_COLS = 15

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

        // Initialize Pillar 4 Assembly Board Graph
        const board = new WasmPuzzleBoard(BOARD_ROWS, BOARD_COLS)
        boardRef.current = board
        const initialSlots = board.get_slots_json()
        if (Array.isArray(initialSlots)) {
          setBoardSlots(initialSlots)
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

    if (showCalibrationGuides) {
      // 1. Convert current 4 corner fiducial coordinates to undistorted rectilinear space
      const unTL = undistortPt(pts[0].x, pts[0].y, w, h, lensDistortion)
      const unTR = undistortPt(pts[1].x, pts[1].y, w, h, lensDistortion)
      const unBR = undistortPt(pts[2].x, pts[2].y, w, h, lensDistortion)
      const unBL = undistortPt(pts[3].x, pts[3].y, w, h, lensDistortion)

      // 2. Fiducial Delta to Outer Square Extents:
      // On the standardized calibration mat:
      // Inner fiducial centers: 84.00 mm
      // Outer square dimension: 100.00 mm
      // Ratio outer / fiducial: 100 / 84 = 1.190476
      const fiducialToOuterRatio = 100.0 / 84.0
      const centerRect = {
        x: (unTL.x + unTR.x + unBR.x + unBL.x) * 0.25,
        y: (unTL.y + unTR.y + unBR.y + unBL.y) * 0.25,
      }

      const expandFromCenter = (p: Point2D, ratio: number): Point2D => ({
        x: centerRect.x + (p.x - centerRect.x) * ratio,
        y: centerRect.y + (p.y - centerRect.y) * ratio,
      })

      const outerTL = expandFromCenter(unTL, fiducialToOuterRatio)
      const outerTR = expandFromCenter(unTR, fiducialToOuterRatio)
      const outerBR = expandFromCenter(unBR, fiducialToOuterRatio)
      const outerBL = expandFromCenter(unBL, fiducialToOuterRatio)

      // Inner piece staging box: 50.00 mm (ratio 50 / 84 = 0.595)
      const stagingTL = expandFromCenter(unTL, 50.0 / 84.0)
      const stagingTR = expandFromCenter(unTR, 50.0 / 84.0)
      const stagingBR = expandFromCenter(unBR, 50.0 / 84.0)
      const stagingBL = expandFromCenter(unBL, 50.0 / 84.0)

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
            const distPt = distortPt(interpX, interpY, w, h, lensDistortion)
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

      // Draw Outer Square Guide (100mm border on the mat)
      // When k1 is adjusted correctly, this outline aligns precisely with the printed 100mm outer square!
      drawCurvedPolygon([outerTL, outerTR, outerBR, outerBL], '#ffd33d', 2.0, [6, 4], 'rgba(255, 211, 61, 0.04)')

      // Draw Inner Staging Boundary (50mm piece placement area)
      drawCurvedPolygon([stagingTL, stagingTR, stagingBR, stagingBL], '#3fb950', 1.5, [4, 4], 'rgba(63, 185, 80, 0.03)')

      // Draw Fiducial Quadrilateral (connecting the 4 fiducials)
      drawCurvedPolygon([unTL, unTR, unBR, unBL], '#58a6ff', 1.5, [3, 3])

      // Center crosshairs
      const cDist = distortPt(centerRect.x, centerRect.y, w, h, lensDistortion)
      ctx.beginPath()
      ctx.strokeStyle = 'rgba(255, 211, 61, 0.6)'
      ctx.lineWidth = 1.0
      ctx.moveTo(cDist.x - 12, cDist.y)
      ctx.lineTo(cDist.x + 12, cDist.y)
      ctx.moveTo(cDist.x, cDist.y - 12)
      ctx.lineTo(cDist.x, cDist.y + 12)
      ctx.stroke()

      // Diagnostic guide labels
      ctx.fillStyle = '#ffd33d'
      ctx.font = '10px monospace'
      const topLabelPt = distortPt(
        (outerTL.x + outerTR.x) * 0.5,
        outerTL.y - 6,
        w,
        h,
        lensDistortion
      )
      ctx.fillText(`OUTER SQUARE: 100mm (k1=${lensDistortion.toFixed(2)})`, topLabelPt.x - 90, topLabelPt.y)
    }

    // Draw the 4 interactive draggable corner handles on the fiducials
    const labels = ['FID 0: TL', 'FID 1: TR', 'FID 2: BR', 'FID 3: BL']
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
    } catch { }
  }

  const processLoop = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const dewarpedCanvas = dewarpedCanvasRef.current

    if (video && canvas && video.readyState >= 2 && wasmReady) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        const targetW = 960
        const targetH = Math.round((video.videoHeight / video.videoWidth) * targetW) || 540
        frameDimsRef.current = { w: targetW, h: targetH }

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
              dstH,
              lensDistortion
            )
            latestDewarpedRef.current = { bytes: dewarpedBytes, w: dstW, h: dstH }

            const dCtx = dewarpedCanvas.getContext('2d')
            if (dCtx) {
              // Run piece boundary contour segmentation
              const analysisResult = analyze_staged_piece(dewarpedBytes, dstW, dstH, segSensitivity)
              setLatestAnalysis(analysisResult)

              const piece: ScannedPiece | null = analysisResult?.piece || null
              setDetectedPiece(piece)

              if (analysisResult?.binary_mask) {
                latestBinaryMaskRef.current = new Uint8Array(analysisResult.binary_mask)
              }

              // Render staging canvas according to selected view mode
              const dewarpedImageData = dCtx.createImageData(dstW, dstH)
              if (viewMode === 'binary' && analysisResult?.binary_mask) {
                const mask = analysisResult.binary_mask
                for (let i = 0; i < dstW * dstH; i++) {
                  const val = mask[i]
                  dewarpedImageData.data[i * 4] = val
                  dewarpedImageData.data[i * 4 + 1] = val
                  dewarpedImageData.data[i * 4 + 2] = val
                  dewarpedImageData.data[i * 4 + 3] = 255
                }
              } else {
                dewarpedImageData.data.set(dewarpedBytes)
              }
              dCtx.putImageData(dewarpedImageData, 0, 0)

              if (piece && (viewMode === 'composite' || viewMode === 'dewarped')) {
                drawPieceDiagnostics(dCtx, piece)

                // Hands-Free Auto-Capture Motion Debouncing:
                const now = performance.now()
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
                // Arena completely empty: clear lockout so next piece can be registered
                steadySinceRef.current = null
                lastCenterRef.current = null
                hasCapturedRef.current = false
                isAwaitingPieceRemovalRef.current = false
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
  }, [wasmReady, corners, autoDewarp, draggingIdx, snappedIndex, lensDistortion, segSensitivity, viewMode, showCalibrationGuides])


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
    setStagedHistory((prev) => [piece, ...prev.slice(0, 11)])
    setAutoCaptureNotice('PIECE REGISTERED')
    setTimeout(() => setAutoCaptureNotice(null), 1500)

    // Compute board slot matches ONLY on capture
    if (boardRef.current) {
      try {
        const cands = boardRef.current.find_candidates(piece)
        if (Array.isArray(cands)) {
          setSlotCandidates(cands)
          setSelectedCandidate(cands.length > 0 ? cands[0] : null)
        }
      } catch (e) {
        console.warn('Candidate calculation error:', e)
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

  const handleResetCorners = () => {
    setCorners(DEFAULT_CORNERS)
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

  // Candidate slots are updated upon piece capture (manual or auto-capture)
  useEffect(() => {
    if (!detectedPiece) {
      // Clear live candidates when stage is cleared
      setSlotCandidates([])
      setSelectedCandidate(null)
    }
  }, [detectedPiece])

  const handlePlacePieceAtSlot = (candidate: SlotCandidate) => {
    if (!detectedPiece || !boardRef.current) return
    const pieceId = stagedHistory.length + 1
    try {
      const ok = boardRef.current.place_piece(
        pieceId,
        detectedPiece,
        candidate.row,
        candidate.col,
        candidate.rotation
      )
      if (ok) {
        playCaptureTone()
        setBoardSlots(boardRef.current.get_slots_json())
        setStagedHistory((prev) => [detectedPiece, ...prev.slice(0, 11)])
        setAutoCaptureNotice(`✓ Placed Piece #${pieceId} at (${candidate.row}, ${candidate.col})!`)
        setTimeout(() => setAutoCaptureNotice(null), 2000)
        // Refresh candidates for current piece
        setSlotCandidates([])
        setSelectedCandidate(null)
      }
    } catch (e: any) {
      alert(`Could not place piece: ${e}`)
    }
  }

  const handleUnplacePiece = (row: number, col: number) => {
    if (!boardRef.current) return
    boardRef.current.unplace_piece(row, col)
    setBoardSlots(boardRef.current.get_slots_json())
  }

  return (
    <div className="app-container">
      <div className="main-content">
        <section className="viewport-panel">
          <div className="panel-header">
            <span>OPTICAL STAGE & CALIBRATION</span>
            <span>{isCameraActive ? `1080P STREAM (${fps} FPS)` : 'STANDBY'}</span>
          </div>

          <div className="video-container">
            <div className="video-stage-wrapper">
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
            </div>

            {!isCameraActive && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                <p style={{ margin: '0 0 12px 0', textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: '0.85rem' }}>
                  Video device offline
                </p>
                <button className="primary" onClick={startCamera} disabled={!wasmReady}>
                  START CAPTURE
                </button>
              </div>
            )}
          </div>

          {isCameraActive && (
            <div className="controls-bar">
              <button onClick={stopCamera}>STOP STREAM</button>
              <button
                onClick={() => setAutoDewarp(!autoDewarp)}
                style={{ borderColor: autoDewarp ? '#3fb950' : '#30363d' }}
              >
                {autoDewarp ? 'DEWARP: ON' : 'DEWARP: OFF'}
              </button>
              <button onClick={handleResetCorners}>RESET CORNERS</button>
              <button
                className="primary"
                onClick={handleManualLockPiece}
                disabled={!detectedPiece}
                style={{
                  opacity: detectedPiece ? 1 : 0.45,
                  cursor: detectedPiece ? 'pointer' : 'not-allowed',
                }}
              >
                RECORD PIECE [{stagedHistory.length + 1}]
              </button>
              <button onClick={() => handleSaveSnapshot(false)}>
                SAVE DATA
              </button>
              <button onClick={() => handleSaveSnapshot(true)} title="Save full bundle with base64 images">
                SAVE FULL SNAPSHOT
              </button>
              <div className="controls-status-slot">
                <span
                  style={{
                    color: snapshotStatus ? '#ffd33d' : autoCaptureNotice ? '#3fb950' : snappedIndex !== null ? '#58a6ff' : 'var(--text-muted)',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    letterSpacing: '0.5px',
                  }}
                >
                  {snapshotStatus ? `SNAPSHOT: ${snapshotStatus}` : autoCaptureNotice ? `STATUS: ${autoCaptureNotice}` : snappedIndex !== null ? 'STATUS: FIDUCIAL LOCKED' : 'STATUS: READY'}
                </span>
              </div>
            </div>
          )}

          {/* Optical Calibration Tool Bar */}
          {isCameraActive && (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '16px',
              padding: '8px 14px',
              background: '#0a0d11',
              borderTop: '1px solid var(--border-color)',
              fontSize: '0.75rem',
              alignItems: 'center'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--text-muted)' }}>LENS DISTORTION (K1):</span>
                <input
                  type="range"
                  min="-0.5"
                  max="0.5"
                  step="0.01"
                  value={lensDistortion}
                  onChange={(e) => setLensDistortion(parseFloat(e.target.value))}
                  style={{ width: '110px' }}
                />
                <code style={{ minWidth: '40px', color: '#ffd33d' }}>{lensDistortion.toFixed(2)}</code>
                <button
                  onClick={() => setLensDistortion(0.0)}
                  style={{ padding: '1px 6px', fontSize: '0.65rem' }}
                  title="Reset distortion to 0"
                >
                  ZERO
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={() => setShowCalibrationGuides(!showCalibrationGuides)}
                  style={{
                    padding: '2px 8px',
                    fontSize: '0.7rem',
                    background: showCalibrationGuides ? '#242c37' : 'transparent',
                    borderColor: showCalibrationGuides ? '#ffd33d' : 'var(--border-color)',
                    color: showCalibrationGuides ? '#ffd33d' : 'var(--text-muted)',
                  }}
                  title="Show 100mm outer square and fiducial calibration guide lines directly on live video"
                >
                  {showCalibrationGuides ? 'MAT GUIDES: ON' : 'MAT GUIDES: OFF'}
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--text-muted)' }}>SENSITIVITY:</span>
                <input
                  type="range"
                  min="12"
                  max="60"
                  step="1"
                  value={segSensitivity}
                  onChange={(e) => setSegSensitivity(parseFloat(e.target.value))}
                  style={{ width: '90px' }}
                />
                <code>{segSensitivity.toFixed(0)}</code>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--text-muted)' }}>INSPECTION VIEW:</span>
                {(['composite', 'binary', 'dewarped'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setViewMode(m)}
                    style={{
                      padding: '2px 8px',
                      fontSize: '0.7rem',
                      background: viewMode === m ? '#242c37' : 'transparent',
                      borderColor: viewMode === m ? '#58a6ff' : 'var(--border-color)',
                      color: viewMode === m ? '#58a6ff' : 'var(--text-muted)'
                    }}
                  >
                    {m.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Assembly Board Grid & Recommendations */}
          <BoardView
            rows={BOARD_ROWS}
            cols={BOARD_COLS}
            slots={boardSlots}
            candidates={slotCandidates}
            selectedCandidate={selectedCandidate}
            onSelectCandidate={setSelectedCandidate}
            onPlacePieceAtSlot={handlePlacePieceAtSlot}
            onUnplacePiece={handleUnplacePiece}
          />
        </section>

        <aside className="side-panel">
          <div className="card">
            <h3>CONTOUR & PROFILE ANALYSIS</h3>
            <p style={{ color: cameraError ? '#f85149' : 'var(--text-muted)', fontSize: '0.75rem', margin: '0 0 6px 0' }}>
              DIAGNOSTIC: {cameraError ? `ERROR: ${cameraError}` : 'NOMINAL'}
            </p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', margin: 0 }}>
              PCA ORIENTATION / CONTOUR EXTRACTION
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
              <canvas
                ref={dewarpedCanvasRef}
                style={{
                  border: '1px solid var(--border-color)',
                  borderRadius: '2px',
                  background: '#0d1117',
                  width: '320px',
                  height: '320px',
                  maxWidth: '100%',
                  aspectRatio: '1 / 1',
                  imageRendering: 'pixelated',
                }}
              />
            </div>

            <div className="piece-details-container">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span>CLASS:</span>
                <strong style={{
                  color: detectedPiece ? (detectedPiece.is_corner ? '#f85149' : detectedPiece.is_border ? '#d29922' : '#3fb950') : 'var(--text-muted)'
                }}>
                  {detectedPiece
                    ? (detectedPiece.is_corner ? 'CORNER' : detectedPiece.is_border ? 'BORDER' : 'INTERIOR')
                    : 'NO TARGET DETECTED'}
                </strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span>DIMENSIONS:</span>
                <code style={{ color: detectedPiece ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {detectedPiece
                    ? `${(detectedPiece.bounding_width * 0.22).toFixed(1)} mm × ${(detectedPiece.bounding_height * 0.22).toFixed(1)} mm`
                    : '-- mm × -- mm'}
                </code>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <span>ROTATION:</span>
                <code style={{ color: detectedPiece ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  {detectedPiece
                    ? `${((detectedPiece.rotation_angle_rad * 180) / Math.PI).toFixed(1)}°`
                    : '--°'}
                </code>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>EDGES:</span>
                <span style={{ display: 'inline-flex', gap: '4px' }}>
                  {detectedPiece ? (
                    detectedPiece.edges.map((e, idx) => (
                      <span key={idx} style={{
                        padding: '1px 5px',
                        borderRadius: '2px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        border: '1px solid var(--border-color)',
                        background: 'rgba(0,0,0,0.3)',
                        color: e.edge_type === 'Tab' ? '#58a6ff' : e.edge_type === 'Hole' ? '#d29922' : '#a371f7'
                      }}>
                        {e.edge_type.toUpperCase()}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>--</span>
                  )}
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>PIECE INVENTORY ({stagedHistory.length})</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', height: '140px', overflowY: 'auto' }}>
              {stagedHistory.length === 0 ? (
                <div style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '0.75rem',
                  border: '1px dashed var(--border-color)',
                  borderRadius: '2px',
                  padding: '10px'
                }}>
                  NO PIECES REGISTERED
                </div>
              ) : (
                stagedHistory.map((p, i) => (
                  <div key={i} style={{
                    fontSize: '0.75rem',
                    padding: '6px 8px',
                    borderRadius: '2px',
                    background: 'rgba(0,0,0,0.3)',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexShrink: 0
                  }}>
                    <span>PIECE #{stagedHistory.length - i} ({((p.rotation_angle_rad * 180) / Math.PI).toFixed(0)}&deg;)</span>
                    <span style={{ color: p.is_corner ? '#f85149' : p.is_border ? '#d29922' : '#3fb950', fontWeight: 600 }}>
                      {p.is_corner ? 'CORNER' : p.is_border ? 'BORDER' : 'INTERIOR'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <h3>SYSTEM METRICS</h3>
            <div className="metric-grid">
              <div className="metric-box">
                <div className="metric-label">RESOLUTION</div>
                <div className="metric-val">
                  {stats ? `${stats.width}×${stats.height}` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">LATENCY</div>
                <div className="metric-val">
                  {stats ? `${stats.elapsed_ms.toFixed(2)}ms` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">LUMINANCE</div>
                <div className="metric-val">
                  {stats ? stats.avg_brightness.toFixed(1) : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">FPS</div>
                <div className="metric-val">{fps}</div>
              </div>

              <div className="metric-box">
                <div className="metric-label">18% GRAY CARD</div>
                <div className="metric-val" style={{ fontSize: '0.85rem' }}>
                  {latestAnalysis?.gray_card_rgb ? `rgb(${latestAnalysis.gray_card_rgb.join(',')})` : '--'}
                </div>
              </div>

              <div className="metric-box">
                <div className="metric-label">BG BASELINE</div>
                <div className="metric-val" style={{ fontSize: '0.85rem' }}>
                  {latestAnalysis?.bg_mean_rgb ? `rgb(${latestAnalysis.bg_mean_rgb.join(',')})` : '--'}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default App
