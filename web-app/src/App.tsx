import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import init, {
  dewarp_quad,
  snap_fiducial_corner,
  measure_stage_focus,
  analyze_staged_piece,
  map_dewarped_points_to_camera,
  init_master_poster_spatial,
  locate_piece_spatial,
  identify_staged_piece_wasm,
  solve_perimeter_1d_loop_wasm,
} from './pkg/cv_engine'
import { BoardView } from './components/BoardView'
import type { CandidateMatchOverlay } from './components/BoardView'
import { PieceTray } from './components/PieceTray'
import type { StoredPiece, PlacedBoardSlot, GroundTruthPairFixture } from './storage/db'
import {
  getAllPieces,
  savePiece,
  deletePiece,
  clearAllPieces,
  getAllPlacedSlots,
  placePieceOnBoard,
  unplacePieceFromBoard,
  exportAssemblyDataset,
  importAssemblyDataset,
  getAllPairedFixtures,
  updatePairedFixtureStatus,
  syncLocalMatingPairs,
} from './storage/db'
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
  normalized_profile?: number[]
  fourier_descriptor?: number[]
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
  /** Human-verified / manually positioned corners (ground truth label) */
  corners: [Point2D, Point2D, Point2D, Point2D]
  /** CV-detected corners at the moment of freeze, before any manual adjustment */
  detected_corners: [Point2D, Point2D, Point2D, Point2D]
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

export function getOrComputeNormalizedProfile(edge: any): number[] {
  if (edge.normalized_profile && Array.isArray(edge.normalized_profile) && edge.normalized_profile.length >= 10) {
    return Array.from(edge.normalized_profile)
  }
  const samples = edge.curve_samples
  const pStart = edge.start_corner
  const pEnd = edge.end_corner
  if (!samples || samples.length === 0 || !pStart || !pEnd) {
    return new Array(100).fill(0)
  }
  const baseDx = pEnd.x - pStart.x
  const baseDy = pEnd.y - pStart.y
  const baseLen = Math.max(1.0, Math.sqrt(baseDx * baseDx + baseDy * baseDy))

  const normProfile: number[] = []
  const nS = samples.length
  for (let k = 0; k < 100; k++) {
    const t = k / 99.0
    const sampleIdx = Math.min(nS - 1, Math.round(t * (nS - 1)))
    const s = samples[sampleIdx]
    const distToChord = ((s.x - pStart.x) * baseDy - (s.y - pStart.y) * baseDx) / baseLen
    normProfile.push(distToChord / baseLen)
  }
  return normProfile
}

export default function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [focusScore, setFocusScore] = useState<number>(0)
  const [detectedPiece, setDetectedPiece] = useState<ScannedPiece | null>(null)
  const [scannedPieces, setScannedPieces] = useState<ScannedPiece[]>([])

  // Phase 7: Persistent Inventory & Board State
  const [storedPieces, setStoredPieces] = useState<StoredPiece[]>([])
  const [placedSlots, setPlacedSlots] = useState<Record<string, PlacedBoardSlot>>({})
  const [selectedBoardSlot, setSelectedBoardSlot] = useState<{ row: number; col: number } | null>(null)

  // Shared Reference Poster for Underlay, Mode C Previews, and Coordinate Localization
  const [posterRgba, setPosterRgba] = useState<Uint8Array | null>(null)
  const [posterFileName, setPosterFileName] = useState<string>('')
  const [posterDims, setPosterDims] = useState<{ w: number; h: number; cols: number; rows: number }>(() => {
    const savedCols = localStorage.getItem('jigsaw_grid_cols')
    const savedRows = localStorage.getItem('jigsaw_grid_rows')
    return {
      w: 0,
      h: 0,
      cols: savedCols ? parseInt(savedCols) || 36 : 36,
      rows: savedRows ? parseInt(savedRows) || 28 : 28,
    }
  })
  const [physDims, setPhysDims] = useState<{ wMm: number; hMm: number }>(() => {
    const savedW = localStorage.getItem('jigsaw_phys_w')
    const savedH = localStorage.getItem('jigsaw_phys_h')
    return {
      wMm: savedW ? parseFloat(savedW) || 700 : 700,
      hMm: savedH ? parseFloat(savedH) || 500 : 500,
    }
  })

  // Phase 8: Unified Cockpit & Real-Time Poster Localization State
  const [pairedFixtures, setPairedFixtures] = useState<GroundTruthPairFixture[]>([])
  const [activePosterMatch, setActivePosterMatch] = useState<{
    best_col: number
    best_row: number
    best_rotation_deg: number
    confidence: number
    top_candidates: { col: number; row: number; rotation_deg: number; confidence: number }[]
  } | null>(null)
  const activePosterMatchRef = useRef(activePosterMatch)
  activePosterMatchRef.current = activePosterMatch
  const placedSlotsRef = useRef(placedSlots)
  placedSlotsRef.current = placedSlots
  const posterDimsRef = useRef(posterDims)
  posterDimsRef.current = posterDims
  const recentMatchesRef = useRef<{ match: any; timestamp: number }[]>([])
  const lastLocalizationTimeRef = useRef<number>(0)
  const isPosterInitializedRef = useRef<boolean>(false)
  const lastFocusTimeRef = useRef<number>(0)

  // Phase 9: Drop-to-Locate & 1D Perimeter Loop State
  const [solvedPerimeterMap, setSolvedPerimeterMap] = useState<Record<string, {
    piece_id: string
    piece_number: number
    row: number
    col: number
    rotation: number
    confidence: number
  }>>({})
  const solvedPerimeterMapRef = useRef(solvedPerimeterMap)
  solvedPerimeterMapRef.current = solvedPerimeterMap

  const [identifiedPieceMatch, setIdentifiedPieceMatch] = useState<{
    is_matched: boolean
    piece_id: string
    piece_number: number
    rotation_offset: number
    identity_distance: number
    confidence: number
  } | null>(null)
  const identifiedPieceMatchRef = useRef(identifiedPieceMatch)
  identifiedPieceMatchRef.current = identifiedPieceMatch

  const storedPiecesRef = useRef(storedPieces)
  storedPiecesRef.current = storedPieces

  // Load persistent pieces and board state from IndexedDB on startup
  const refreshStorage = useCallback(async () => {
    try {
      const [allPieces, allSlots, allFixtures] = await Promise.all([
        getAllPieces(),
        getAllPlacedSlots(),
        getAllPairedFixtures(),
      ])
      setStoredPieces(allPieces)
      setPlacedSlots(allSlots)
      setPairedFixtures(allFixtures)

      // Auto-backfill normalized_profile for existing pieces that were recorded without it
      const missingProfiles = allPieces.filter(
        (p) => p.edges.some((e) => !e.normalized_profile || e.normalized_profile.length < 10)
      )
      if (missingProfiles.length > 0) {
        Promise.all(
          missingProfiles.map((p) => {
            const updated = {
              ...p,
              edges: p.edges.map((e) => ({
                ...e,
                normalized_profile: getOrComputeNormalizedProfile(e),
              })) as any,
            }
            return savePiece(updated)
          })
        )
          .then(() => console.log(`Auto-upgraded ${missingProfiles.length} pieces with normalized profiles`))
          .catch((err) => console.warn('Profile backfill non-fatal error:', err))
      }
    } catch (err) {
      console.error('Failed to load from IndexedDB:', err)
    }
  }, [])

  useEffect(() => {
    refreshStorage()
  }, [refreshStorage])

  // Auto-load master reference poster from /public if available
  useEffect(() => {
    if (!wasmReady || posterRgba) return
    const img = new Image()
    img.src = '/poster_reference.jpg'
    img.onload = () => {
      const off = document.createElement('canvas')
      off.width = img.naturalWidth
      off.height = img.naturalHeight
      const ctx = off.getContext('2d')
      if (ctx) {
        ctx.drawImage(img, 0, 0)
        const imgData = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight)
        const bytes = new Uint8Array(imgData.data.buffer)
        setPosterRgba(bytes)
        setPosterFileName('poster_reference.jpg')
        const savedCols = localStorage.getItem('jigsaw_grid_cols')
        const savedRows = localStorage.getItem('jigsaw_grid_rows')
        const initCols = savedCols ? parseInt(savedCols) || 36 : 36
        const initRows = savedRows ? parseInt(savedRows) || 28 : 28
        setPosterDims({
          w: img.naturalWidth,
          h: img.naturalHeight,
          cols: initCols,
          rows: initRows,
        })
        try {
          init_master_poster_spatial(bytes, img.naturalWidth, img.naturalHeight, initCols, initRows)
          isPosterInitializedRef.current = true
          console.log(`Master poster initialized in WASM memory (${initCols}x${initRows}, ${initCols * initRows} slots)`)
        } catch (err) {
          console.error('Failed to init master poster spatial:', err)
        }
      }
    }
  }, [wasmReady, posterRgba])

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
  /** CV-detected corners at the instant of freeze — never mutated by the user */
  const [gtDetectedCorners, setGtDetectedCorners] = useState<[Point2D, Point2D, Point2D, Point2D] | null>(null)
  const [draggingGtCorner, setDraggingGtCorner] = useState<number | null>(null)
  const [gtSavedCount, setGtSavedCount] = useState<number>(0)
  const [gtSaveStatus, setGtSaveStatus] = useState<string | null>(null)

  // View Switchers & Modals
  const [isCalibratingFullScreen, setIsCalibratingFullScreen] = useState<boolean>(false)
  const [activeTopView, setActiveTopView] = useState<'board' | 'tray'>('board')
  const [inspectedPiece, setInspectedPiece] = useState<StoredPiece | null>(null)
  const [activePlacementPiece, setActivePlacementPiece] = useState<StoredPiece | null>(null)
  const [showResetConfirm, setShowResetConfirm] = useState<boolean>(false)

  // Saving debounce & frame-jitter tolerance
  const isSavingRef = useRef<boolean>(false)
  const lastValidPieceRef = useRef<{ piece: ScannedPiece; timestamp: number } | null>(null)

  // Audio Detection & Audio Feedback
  const wasPieceDetectedRef = useRef<boolean>(false)
  const lastAudioDetectTimeRef = useRef<number>(0)

  // Scanner UI & Ergonomics
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)

  // Memoize top candidate matches for direct rendering on the Assembly Board grid
  const candidateMatches = useMemo<CandidateMatchOverlay[]>(() => {
    // If perimeter loop sequenced this piece (from camera or selected for placement), highlight its perimeter slot as #1
    const targetPieceId = activePlacementPiece?.id || identifiedPieceMatch?.piece_id
    if (targetPieceId && solvedPerimeterMap[targetPieceId]) {
      const plc = solvedPerimeterMap[targetPieceId]
      return [
        {
          row: plc.row,
          col: plc.col,
          rotation_deg: plc.rotation * 90,
          confidence: identifiedPieceMatch?.confidence || 95,
          rank: 1,
        },
      ]
    }
    if (!activePosterMatch) return []
    const list = activePosterMatch.top_candidates && activePosterMatch.top_candidates.length > 0
      ? activePosterMatch.top_candidates
      : [{ col: activePosterMatch.best_col, row: activePosterMatch.best_row, rotation_deg: activePosterMatch.best_rotation_deg, confidence: activePosterMatch.confidence }]
    return list.slice(0, 5).map((cand, idx) => ({
      row: cand.row,
      col: cand.col,
      rotation_deg: cand.rotation_deg,
      confidence: cand.confidence,
      rank: idx + 1,
    }))
  }, [activePlacementPiece, activePosterMatch, identifiedPieceMatch, solvedPerimeterMap])

  const playSaveSound = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(659.25, ctx.currentTime) // E5
      osc.frequency.exponentialRampToValueAtTime(1046.5, ctx.currentTime + 0.08) // C6
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.12)
    } catch { }
  }

  const playDetectSound = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(880, ctx.currentTime) // A5
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08) // E6
      gain.gain.setValueAtTime(0.12, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.16)
    } catch { }
  }

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
    lensK1: number,
    activePiece?: ScannedPiece | null
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
    ctx.strokeStyle = '#ff00ffff' // High-contrast neon cyan
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
    ctx.strokeStyle = 'ff00ffff'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Sub-pixel white center point
    ctx.beginPath()
    ctx.arc(cx, cy, 2.0, 0, Math.PI * 2)
    ctx.fillStyle = '#ff00ffff'
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

    // 5. In-situ Augmented Reality: Project detected piece diagnostics directly onto the physical camera stage
    if (activePiece && wasmReady) {
      const dstW = 384
      const dstH = 384
      const rawContour = activePiece.contour_points
      if (rawContour.length > 2) {
        // Flatten contour points for batch WASM projection
        const flatContour: number[] = []
        for (let i = 0; i < rawContour.length; i++) {
          flatContour.push(rawContour[i].x, rawContour[i].y)
        }
        const projContour = map_dewarped_points_to_camera(
          new Float32Array(flatContour),
          w, h,
          pts[0].x, pts[0].y,
          pts[1].x, pts[1].y,
          pts[2].x, pts[2].y,
          pts[3].x, pts[3].y,
          dstW, dstH,
          lensK1
        )

        const numPts = projContour.length / 2
        if (numPts > 2) {
          ctx.save()
          ctx.beginPath()
          const startX = (projContour[(numPts - 1) * 2] + projContour[0]) * 0.5
          const startY = (projContour[(numPts - 1) * 2 + 1] + projContour[1]) * 0.5
          ctx.moveTo(startX, startY)
          for (let i = 0; i < numPts; i++) {
            const cx = projContour[i * 2]
            const cy = projContour[i * 2 + 1]
            const nextX = projContour[((i + 1) % numPts) * 2]
            const nextY = projContour[((i + 1) % numPts) * 2 + 1]
            ctx.quadraticCurveTo(cx, cy, (cx + nextX) * 0.5, (cy + nextY) * 0.5)
          }
          ctx.closePath()
          ctx.strokeStyle = '#00e676'
          ctx.lineWidth = 2.5
          ctx.stroke()
          ctx.fillStyle = 'rgba(0, 230, 118, 0.12)'
          ctx.fill()
          ctx.restore()
        }

        // Project 4 Corners to camera space
        const flatCorners = [
          activePiece.corners[0].x, activePiece.corners[0].y,
          activePiece.corners[1].x, activePiece.corners[1].y,
          activePiece.corners[2].x, activePiece.corners[2].y,
          activePiece.corners[3].x, activePiece.corners[3].y,
        ]
        const projCorners = map_dewarped_points_to_camera(
          new Float32Array(flatCorners),
          w, h,
          pts[0].x, pts[0].y,
          pts[1].x, pts[1].y,
          pts[2].x, pts[2].y,
          pts[3].x, pts[3].y,
          dstW, dstH,
          lensK1
        )

        // Draw baseline chords and badges in camera space
        const edgeColors: Record<string, string> = {
          Tab: '#2979ff',
          Hole: '#ff9100',
          Flat: '#ab47bc',
        }
        for (let i = 0; i < 4; i++) {
          const edge = activePiece.edges[i]
          const c1x = projCorners[i * 2]
          const c1y = projCorners[i * 2 + 1]
          const nextIdx = (i + 1) % 4
          const c2x = projCorners[nextIdx * 2]
          const c2y = projCorners[nextIdx * 2 + 1]

          const color = edgeColors[edge.edge_type] || '#ffffff'
          ctx.save()
          ctx.beginPath()
          ctx.moveTo(c1x, c1y)
          ctx.lineTo(c2x, c2y)
          ctx.strokeStyle = color
          ctx.lineWidth = 2.2
          ctx.setLineDash([5, 3])
          ctx.stroke()
          ctx.restore()

          // Edge type badge
          const midX = (c1x + c2x) * 0.5
          const midY = (c1y + c2y) * 0.5
          const label = `E${i}: ${edge.edge_type}`
          ctx.font = 'bold 12px monospace'
          const tw = ctx.measureText(label).width
          const bw = tw + 10
          const bh = 18

          ctx.fillStyle = 'rgba(20, 25, 30, 0.90)'
          ctx.beginPath()
          ctx.roundRect(midX - bw / 2, midY - bh / 2, bw, bh, 3)
          ctx.fill()
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          ctx.stroke()

          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, midX, midY)
        }

        // Corner circles in camera space
        for (let i = 0; i < 4; i++) {
          const cx = projCorners[i * 2]
          const cy = projCorners[i * 2 + 1]
          ctx.beginPath()
          ctx.arc(cx, cy, 6.0, 0, Math.PI * 2)
          ctx.fillStyle = '#d32f2f'
          ctx.fill()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 2.0
          ctx.stroke()

          ctx.beginPath()
          ctx.arc(cx, cy, 2.0, 0, Math.PI * 2)
          ctx.fillStyle = '#ffffff'
          ctx.fill()
        }

        // Phase 9: Drop-to-Locate or Phase 8 Poster Proposal Badge in Camera Space
        const idMatch = identifiedPieceMatchRef.current
        const solvedMap = solvedPerimeterMapRef.current
        const solvedPlc = (idMatch && idMatch.is_matched) ? solvedMap[idMatch.piece_id] : null

        if (idMatch?.is_matched || activePosterMatch) {
          const pCenter = map_dewarped_points_to_camera(
            new Float32Array([activePiece.center.x, activePiece.center.y]),
            w, h,
            pts[0].x, pts[0].y,
            pts[1].x, pts[1].y,
            pts[2].x, pts[2].y,
            pts[3].x, pts[3].y,
            dstW, dstH,
            lensK1
          )
          const pCX = pCenter[0]
          const pCY = pCenter[1] - 42

          let hudText = ''
          let borderColor = '#58a6ff'
          let textColor = '#ffffff'

          if (solvedPlc && idMatch) {
            hudText = `PIECE #${idMatch.piece_number} -> [R${solvedPlc.row}, C${solvedPlc.col}] (${solvedPlc.rotation * 90}°) — ${idMatch.confidence.toFixed(0)}%`
            borderColor = '#2ea043'
            textColor = '#3fb950'
          } else if (idMatch?.is_matched) {
            hudText = `PIECE #${idMatch.piece_number} (${idMatch.rotation_offset * 90}°) — ${idMatch.confidence.toFixed(0)}%`
            borderColor = '#d29922'
            textColor = '#e3b341'
          } else if (activePosterMatch) {
            hudText = `POSTER: [R${activePosterMatch.best_row}, C${activePosterMatch.best_col}] (${activePosterMatch.best_rotation_deg.toFixed(0)}°) — ${((activePosterMatch.confidence) * 100).toFixed(0)}%`
            borderColor = '#ffd33d'
            textColor = '#ffd33d'
          }

          ctx.font = 'bold 14px monospace'
          const htw = ctx.measureText(hudText).width
          const hbw = htw + 16
          const hbh = 26

          ctx.fillStyle = 'rgba(22, 27, 34, 0.95)'
          ctx.beginPath()
          ctx.roundRect(pCX - hbw / 2, pCY - hbh / 2, hbw, hbh, 4)
          ctx.fill()
          ctx.strokeStyle = borderColor
          ctx.lineWidth = 2.0
          ctx.stroke()

          ctx.fillStyle = textColor
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(hudText, pCX, pCY)
        }
      }
    }
  }

  // Draw Diagnostic Overlay on 1:1 Piece Canvas
  const drawPieceDiagnostics = (
    ctx: CanvasRenderingContext2D,
    piece: ScannedPiece,
    detectedCorners?: [Point2D, Point2D, Point2D, Point2D] | null,
  ) => {
    // 1. Draw smooth outer boundary using quadratic bezier curves between contour points
    const pts = piece.contour_points
    if (pts.length > 2) {
      ctx.save()
      ctx.beginPath()
      // Start at midpoint between last and first point
      const startX = (pts[pts.length - 1].x + pts[0].x) * 0.5
      const startY = (pts[pts.length - 1].y + pts[0].y) * 0.5
      ctx.moveTo(startX, startY)
      for (let i = 0; i < pts.length; i++) {
        const curr = pts[i]
        const next = pts[(i + 1) % pts.length]
        // Each contour point is a quadratic control; anchor at midpoint to the next
        ctx.quadraticCurveTo(curr.x, curr.y, (curr.x + next.x) * 0.5, (curr.y + next.y) * 0.5)
      }
      ctx.closePath()
      ctx.strokeStyle = '#00e676'
      ctx.lineWidth = 1.8
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

    // 2. Draw 4 Core Baseline Chords with badges anchored at the stable chord midpoint
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

      // Anchor badge strictly to the geometric midpoint of the baseline chord for 100% stability
      const chordMidX = (edge.start_corner.x + edge.end_corner.x) * 0.5
      const chordMidY = (edge.start_corner.y + edge.end_corner.y) * 0.5

      const label = `E${i}: ${edge.edge_type}`
      ctx.font = 'bold 11px monospace'
      const tw = ctx.measureText(label).width
      const bw = tw + 14
      const bh = 18

      ctx.fillStyle = 'rgba(20, 25, 30, 0.92)'
      ctx.beginPath()
      ctx.roundRect(chordMidX - bw / 2, chordMidY - bh / 2, bw, bh, 3)
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, chordMidX, chordMidY)
    })

    // 3. In GT mode, draw CV-detected corners as ghost pins (white dashed) to show offset from labels
    if (isGtMode && detectedCorners) {
      detectedCorners.forEach((pt, i) => {
        ctx.save()
        ctx.beginPath()
        ctx.arc(pt.x, pt.y, 5.0, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.45)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([3, 3])
        ctx.stroke()
        ctx.restore()
        // Draw a line connecting ghost to the active (cyan) pin
        const active = piece.corners[i]
        const dist = Math.hypot(active.x - pt.x, active.y - pt.y)
        if (dist > 1.5) {
          ctx.save()
          ctx.beginPath()
          ctx.moveTo(pt.x, pt.y)
          ctx.lineTo(active.x, active.y)
          ctx.strokeStyle = 'rgba(255,255,255,0.25)'
          ctx.lineWidth = 1.0
          ctx.setLineDash([2, 4])
          ctx.stroke()
          ctx.restore()
        }
      })
    }

    // 4. Draw 4 Core Physical Corners (C0..C3) (solid pins with dark borders)
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
          const now = performance.now()
          const isCvTick = (now - lastCvTimeRef.current >= 60 && wasmReady) || isGtModeRef.current

          // Run Rust WASM piece analysis ~16 times/sec (every 60ms for instant piece detection)
          if (isCvTick) {
            lastCvTimeRef.current = now

            // Extract pixel buffer from canvas only on CV analysis ticks to prevent 60fps GPU readback stalls
            const imgData = ctx.getImageData(0, 0, targetW, targetH)
            const rawBytes = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength)
            latestPixelsRef.current = { bytes: rawBytes, w: targetW, h: targetH }

            const curCorners = cornersRef.current
            const curK1 = lensK1Ref.current
            const curSens = sensRef.current

            // Optical focus score (throttled to 350ms to eliminate continuous React re-renders)
            if (now - lastFocusTimeRef.current >= 350) {
              lastFocusTimeRef.current = now
              const mtf = measure_stage_focus(
                rawBytes, targetW, targetH,
                curCorners[0].x, curCorners[0].y,
                curCorners[1].x, curCorners[1].y,
                curCorners[2].x, curCorners[2].y,
                curCorners[3].x, curCorners[3].y
              )
              setFocusScore(mtf)
            }

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
              let liveMask: Uint8Array | null = null

              // Piece boundary & corner analysis (only update live piece if not in GT mode)
              if (!isGtModeRef.current) {
                const result = analyze_staged_piece(dewarped, dstW, dstH, curSens)
                const rawPiece: ScannedPiece | null = result?.piece || null
                if (result?.binary_mask) {
                  liveMask = new Uint8Array(result.binary_mask)
                }

                // Multi-Frame Stability Consensus Filter:
                if (rawPiece) {
                  if (!wasPieceDetectedRef.current && performance.now() - lastAudioDetectTimeRef.current > 1000) {
                    playDetectSound()
                    lastAudioDetectTimeRef.current = performance.now()
                  }
                  wasPieceDetectedRef.current = true

                  const history = pieceHistoryRef.current
                  const isContinuous = history.length > 0 &&
                    Math.hypot(rawPiece.center.x - history[0].center.x, rawPiece.center.y - history[0].center.y) < 14.0

                  if (!isContinuous) {
                    // Instant frame-1 response: show raw detected piece immediately
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

                    // 1. Stable Corner Association (match each median corner to nearest prev corner by distance to avoid index hopping)
                    const prevLiveCorners = detectedPieceRef.current?.corners
                    const centerDisplacement = history[1] ? Math.hypot(
                      rawPiece.center.x - history[1].center.x,
                      rawPiece.center.y - history[1].center.y
                    ) : 10.0

                    // 2. Deadband Lock-On: If piece is stationary (displacement < 1.8px),
                    // lock onto previous corners completely unless an actual corner shifts by > 2.0px.
                    const stabilizedCorners = medianCorners.map((mc, cIdx) => {
                      if (prevLiveCorners && centerDisplacement < 1.8) {
                        const prevC = prevLiveCorners[cIdx]
                        const cornerDist = Math.hypot(mc.x - prevC.x, mc.y - prevC.y)
                        // If jitter is within sensor thermal noise band (< 2.2px), lock position completely (0 jitter)
                        if (cornerDist < 2.2) {
                          return prevC
                        }
                        // If moving slowly, damp smoothly
                        if (cornerDist < 5.0) {
                          return {
                            x: prevC.x * 0.85 + mc.x * 0.15,
                            y: prevC.y * 0.85 + mc.y * 0.15,
                          }
                        }
                      }
                      return mc
                    }) as [Point2D, Point2D, Point2D, Point2D]

                    // Bind stabilized deadband corners directly into edges so connecting lines and labels never wobble
                    const stabilizedEdges = consensusEdges.map((e, idx) => ({
                      ...e,
                      start_corner: stabilizedCorners[idx],
                      end_corner: stabilizedCorners[(idx + 1) % 4],
                    })) as [PieceEdge, PieceEdge, PieceEdge, PieceEdge]

                    livePiece = {
                      ...rawPiece,
                      corners: stabilizedCorners,
                      edges: stabilizedEdges,
                      is_corner: isCorner,
                      is_border: isBorder,
                    }
                  }
                } else {
                  // Transient dropout tolerance (up to 4 missed frames / ~240ms):
                  // Prevents momentary finger retraction shadows from resetting history and causing perceptual wait
                  if (pieceHistoryRef.current.length > 1) {
                    pieceHistoryRef.current.pop()
                    livePiece = detectedPieceRef.current
                  } else {
                    pieceHistoryRef.current = []
                    recentMatchesRef.current = []
                  }
                }

                if (livePiece) {
                  lastValidPieceRef.current = { piece: livePiece, timestamp: performance.now() }
                }
                setDetectedPiece(livePiece)
                detectedPieceRef.current = livePiece

                // Phase 9: Drop-to-Locate Piece Identity Recognition (< 2ms)
                if (livePiece && storedPiecesRef.current.length > 0 && pieceHistoryRef.current.length >= 2) {
                  try {
                    const queryEdges = livePiece.edges.map((e) => ({
                      edge_type: e.edge_type,
                      curvature_depth: e.curvature_depth,
                      normalized_profile: getOrComputeNormalizedProfile(e),
                    }))
                    const indexed = storedPiecesRef.current.map((p) => ({
                      id: p.id,
                      piece_number: p.piece_number,
                      classification: p.classification,
                      edges: p.edges.map((e) => ({
                        edge_type: e.edge_type,
                        curvature_depth: e.curvature_depth,
                        normalized_profile: getOrComputeNormalizedProfile(e),
                      })),
                      mean_rgb: null,
                    }))
                    const idMatch = identify_staged_piece_wasm(JSON.stringify(queryEdges), JSON.stringify(indexed))
                    if (idMatch && idMatch.is_matched) {
                      setIdentifiedPieceMatch(idMatch)
                    } else {
                      setIdentifiedPieceMatch(null)
                    }
                  } catch (err) {
                    // ignore
                  }
                } else if (!livePiece) {
                  setIdentifiedPieceMatch(null)
                }

                // Real-Time Poster Localization (< 4ms fast spatial pyramid candidate search)
                // Require at least 2 frames of piece history so we have established consensus and avoid hand-shadow false borders
                if (livePiece && isPosterInitializedRef.current && pieceHistoryRef.current.length >= 2) {
                  const nowLoc = performance.now()
                  if (nowLoc - lastLocalizationTimeRef.current >= 90) {
                    lastLocalizationTimeRef.current = nowLoc
                    try {
                      const cornerFloats = new Float32Array([
                        livePiece.corners[0].x, livePiece.corners[0].y,
                        livePiece.corners[1].x, livePiece.corners[1].y,
                        livePiece.corners[2].x, livePiece.corners[2].y,
                        livePiece.corners[3].x, livePiece.corners[3].y,
                      ])
                      const flatEdges = new Uint8Array(
                        livePiece.edges.map(e => e.edge_type === 'Flat' ? 1 : 0)
                      )

                      const match = locate_piece_spatial(
                        dewarped,
                        liveMask || new Uint8Array(0),
                        dstW,
                        dstH,
                        livePiece.is_border,
                        livePiece.is_corner,
                        cornerFloats,
                        flatEdges
                      )
                      if (match && match.confidence > 0.35) {
                        // Append to recent match history for temporal consensus and anti-wobble
                        const history = recentMatchesRef.current
                        history.unshift({ match, timestamp: nowLoc })
                        if (history.length > 5) history.pop()

                        // Count votes for candidate slots in the recent window
                        const votes = new Map<string, { count: number; totalConf: number; match: any }>()
                        for (const item of history) {
                          const key = `${item.match.best_row},${item.match.best_col}`
                          const curr = votes.get(key) || { count: 0, totalConf: 0, match: item.match }
                          curr.count += 1
                          curr.totalConf += item.match.confidence
                          votes.set(key, curr)
                        }

                        // Pick highest-scoring candidate
                        let bestCandidate: any = null
                        let maxScore = -1
                        votes.forEach(v => {
                          const score = v.count * 1.5 + v.totalConf
                          if (score > maxScore) {
                            maxScore = score
                            bestCandidate = v.match
                          }
                        })

                        const currentActive = activePosterMatchRef.current
                        if (!currentActive) {
                          // Initial lock: require at least 2 votes or high single-frame confidence (>0.75)
                          if (bestCandidate) {
                            const candKey = `${bestCandidate.best_row},${bestCandidate.best_col}`
                            const candVote = votes.get(candKey)
                            if (candVote && (candVote.count >= 2 || bestCandidate.confidence > 0.75)) {
                              setActivePosterMatch(bestCandidate)
                            }
                          }
                        } else {
                          // Hysteresis: only switch if the new candidate is persistently better
                          const currentKey = `${currentActive.best_row},${currentActive.best_col}`
                          const bestKey = bestCandidate ? `${bestCandidate.best_row},${bestCandidate.best_col}` : null

                          if (bestKey && bestKey !== currentKey) {
                            const newVote = votes.get(bestKey)
                            // Require at least 3 votes for a new candidate, or a decisive confidence lead (> 0.15)
                            if (newVote && (newVote.count >= 3 || (newVote.count >= 2 && bestCandidate.confidence > currentActive.confidence + 0.15))) {
                              setActivePosterMatch(bestCandidate)
                            }
                          } else if (bestCandidate && bestKey === currentKey) {
                            // Update rotation or confidence on current active slot smoothly without flashing
                            setActivePosterMatch(bestCandidate)
                          }
                        }
                      }
                    } catch (locErr) {
                      console.warn('Poster spatial localization error:', locErr)
                    }
                  }
                } else if (!livePiece) {
                  wasPieceDetectedRef.current = false
                  recentMatchesRef.current = []
                  setActivePosterMatch(null)
                }
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
                    }, gtDetectedCorners)
                  } else if (livePiece) {
                    drawPieceDiagnostics(pCtx, livePiece)
                  }
                }
              }


            } catch (cvErr) {
              console.warn('[CV] Frame processing error:', cvErr)
            }
          }



          // Draw camera overlay every frame with in-situ piece projection
          const activePiece = isGtModeRef.current ? gtFrozenPieceRef.current : detectedPieceRef.current
          drawCameraOverlay(targetW, targetH, cornersRef.current, lensK1Ref.current, activePiece)
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

  const handleRecordPiece = async () => {
    if (isSavingRef.current) return

    // Pick live detected piece or recent valid piece (within 1500ms tolerance to absorb frame drops)
    const targetPiece = detectedPiece || (
      lastValidPieceRef.current && (performance.now() - lastValidPieceRef.current.timestamp < 1500)
        ? lastValidPieceRef.current.piece
        : null
    )
    if (!targetPiece) return

    isSavingRef.current = true

    // Optimistic immediate audio + visual feedback (0ms perceived lag)
    playSaveSound()
    const nextPieceNum = storedPieces.length + 1

    // Generate clean thumbnail crop from rectified pieceCanvas or latestDewarpedRef
    let thumbUrl = ''
    if (pieceCanvasRef.current) {
      thumbUrl = pieceCanvasRef.current.toDataURL('image/jpeg', 0.88)
    }

    const flatCount = targetPiece.edges.filter((e) => e.edge_type === 'Flat').length
    const tabCount = targetPiece.edges.filter((e) => e.edge_type === 'Tab').length
    const holeCount = targetPiece.edges.filter((e) => e.edge_type === 'Hole').length
    const classification: 'Corner' | 'Border' | 'Interior' =
      targetPiece.is_corner || flatCount >= 2
        ? 'Corner'
        : targetPiece.is_border || flatCount === 1
          ? 'Border'
          : 'Interior'

    // Compute metric dimensions: stage is 96mm x 96mm across 384x384 px (0.25 mm/px)
    const mmPerPx = 96.0 / 384.0
    const metricW = targetPiece.bounding_width * mmPerPx
    const metricH = targetPiece.bounding_height * mmPerPx

    const now = Date.now()
    const stored: StoredPiece = {
      id: `piece_${now}_${nextPieceNum}`,
      piece_number: nextPieceNum,
      timestamp: now,
      thumbnailDataUrl: thumbUrl,
      corners: [
        { ...targetPiece.corners[0] },
        { ...targetPiece.corners[1] },
        { ...targetPiece.corners[2] },
        { ...targetPiece.corners[3] },
      ],
      edges: targetPiece.edges.map((e) => ({
        edge_type: e.edge_type,
        start_corner: { ...e.start_corner },
        end_corner: { ...e.end_corner },
        curvature_depth: e.curvature_depth,
        curve_samples: e.curve_samples ? e.curve_samples.map((p) => ({ ...p })) : [],
        normalized_profile: Array.from(e.normalized_profile || getOrComputeNormalizedProfile(e)),
      })) as any,
      bounding_width_px: targetPiece.bounding_width,
      bounding_height_px: targetPiece.bounding_height,
      metric_width_mm: metricW,
      metric_height_mm: metricH,
      classification,
      flat_count: flatCount,
      tab_count: tabCount,
      hole_count: holeCount,
      status: 'InTray',
      placed_slot: null,
      is_favorite: false,
      tags: [],
      paired_piece_id: null,
    }

    // Optimistically update React state immediately
    setStoredPieces((prev) => [stored, ...prev])
    setScannedPieces((prev) => [targetPiece, ...prev])
    setSaveFeedback(`SAVED #${nextPieceNum} (${classification.toUpperCase()})`)
    setTimeout(() => setSaveFeedback(null), 1200)

    // Save asynchronously to IndexedDB in background without blocking UI
    savePiece(stored)
      .catch((err) => {
        console.error('Failed to save piece to IndexedDB:', err)
        setSaveFeedback('FAILED TO SAVE')
        setTimeout(() => setSaveFeedback(null), 1500)
      })
      .finally(() => {
        setTimeout(() => {
          isSavingRef.current = false
        }, 150)
      })
  }

  const handleDeletePiece = useCallback(async (pieceId: string) => {
    try {
      await deletePiece(pieceId)
      setPlacedSlots((prev) => {
        const updated = { ...prev }
        let changed = false
        for (const key of Object.keys(updated)) {
          if (updated[key].piece_id === pieceId) {
            delete updated[key]
            changed = true
          }
        }
        return changed ? updated : prev
      })
      setStoredPieces((prev) => prev.filter((p) => p.id !== pieceId))
      setInspectedPiece((prev) => (prev?.id === pieceId ? null : prev))
      setActivePlacementPiece((prev) => (prev?.id === pieceId ? null : prev))
      setSaveFeedback('PIECE DELETED')
      setTimeout(() => setSaveFeedback(null), 1200)
    } catch (err) {
      console.error('Failed to delete piece:', err)
    }
  }, [])

  const handleToggleFavorite = useCallback(async (pieceId: string) => {
    const piece = storedPieces.find((p) => p.id === pieceId)
    if (!piece) return
    const updated = { ...piece, is_favorite: !piece.is_favorite }
    setStoredPieces((prev) => prev.map((p) => (p.id === pieceId ? updated : p)))
    if (inspectedPiece?.id === pieceId) {
      setInspectedPiece(updated)
    }
    if (activePlacementPiece?.id === pieceId) {
      setActivePlacementPiece(updated)
    }
    await savePiece(updated)
  }, [storedPieces, inspectedPiece, activePlacementPiece])

  const handleResetApplication = useCallback(async () => {
    try {
      await clearAllPieces()
      localStorage.removeItem('jigsaw_grid_cols')
      localStorage.removeItem('jigsaw_grid_rows')
      localStorage.removeItem('jigsaw_calibration_corners_v3')
      localStorage.removeItem('jigsaw_phys_w')
      localStorage.removeItem('jigsaw_phys_h')
      setStoredPieces([])
      setPlacedSlots({})
      setPairedFixtures([])
      setScannedPieces([])
      setDetectedPiece(null)
      setActivePosterMatch(null)
      setSelectedBoardSlot(null)
      setSolvedPerimeterMap({})
      setCorners(DEFAULT_CORNERS)
      setPosterDims((prev) => ({ ...prev, cols: 36, rows: 28 }))
      setShowResetConfirm(false)
      setInspectedPiece(null)
      setActivePlacementPiece(null)
      playSaveSound()
    } catch (err) {
      console.error('Failed to reset application:', err)
    }
  }, [playSaveSound])


  // Board placement callbacks with O(1) optimistic update
  const handlePlacePiece = async (row: number, col: number, pieceId: string, rotation: number) => {
    const updatedPlacedSlot: PlacedBoardSlot = {
      row,
      col,
      piece_id: pieceId,
      rotation,
      placed_at: Date.now(),
    }
    const updatedPlacedSlots = {
      ...placedSlots,
      [`${row},${col}`]: updatedPlacedSlot,
    }

    // Optimistic UI state update
    setPlacedSlots(updatedPlacedSlots)

    // Background asynchronous persistence and localized O(1) seam sync
    placePieceOnBoard(row, col, pieceId, rotation).catch(err => console.error('Failed to place piece:', err))
    syncLocalMatingPairs(row, col, posterDims.rows, posterDims.cols, updatedPlacedSlots, storedPieces)
      .then(newPairs => {
        if (newPairs.length > 0) {
          setPairedFixtures(prev => [...prev, ...newPairs])
        }
      })
      .catch(err => console.error('Failed to sync local mating pairs:', err))
  }

  const handleUpdatePairStatus = async (pairId: string, status: 'verified' | 'rejected') => {
    await updatePairedFixtureStatus(pairId, status)
    await refreshStorage()
  }

  // Phase 9: 1D Closed Perimeter Loop Solver
  const handleSolvePerimeter = useCallback(async () => {
    try {
      const curRows = posterDims.rows > 0 ? posterDims.rows : 28
      const curCols = posterDims.cols > 0 ? posterDims.cols : 36

      const indexed = storedPieces.map((p) => ({
        id: p.id,
        piece_number: p.piece_number,
        classification: p.classification,
        edges: p.edges.map((e) => ({
          edge_type: e.edge_type,
          curvature_depth: e.curvature_depth,
          normalized_profile: getOrComputeNormalizedProfile(e),
        })),
        mean_rgb: null,
      }))

      const res = solve_perimeter_1d_loop_wasm(JSON.stringify(indexed), curRows, curCols)
      if (res) {
        if (res.placements && res.placements.length > 0) {
          const map: Record<string, any> = {}
          const updatedPlaced: Record<string, PlacedBoardSlot> = { ...placedSlots }
          for (const plc of res.placements) {
            map[plc.piece_id] = plc
            const key = `${plc.row},${plc.col}`
            updatedPlaced[key] = {
              row: plc.row,
              col: plc.col,
              piece_id: plc.piece_id,
              rotation: plc.rotation,
              placed_at: Date.now(),
            }
            await placePieceOnBoard(plc.row, plc.col, plc.piece_id, plc.rotation)
          }
          setSolvedPerimeterMap(map)
          setPlacedSlots(updatedPlaced)
          setStoredPieces((prev) =>
            prev.map((p) => {
              const plc = map[p.id]
              if (plc) {
                return {
                  ...p,
                  status: 'Placed',
                  placed_slot: { row: plc.row, col: plc.col, rotation: plc.rotation },
                }
              }
              return p
            })
          )
          playSaveSound()
          console.log(`Perimeter Solved & Applied: ${res.total_pieces_placed} pieces placed on board.`)
        }
        if (res.error_message) {
          alert(`Perimeter Status: ${res.error_message} (${res.total_pieces_placed} pieces placed on board)`)
        } else {
          alert(
            `Perimeter 100% Solved! All ${res.total_pieces_placed} border pieces placed onto the assembly board.`
          )
        }
      }
    } catch (err) {
      console.error('Failed to solve perimeter:', err)
      alert('Error solving perimeter loop: ' + String(err))
    }
  }, [storedPieces, posterDims, placedSlots, playSaveSound])

  // Explicitly apply or re-apply solved perimeter to board
  const handleApplyPerimeterToBoard = useCallback(async () => {
    if (Object.keys(solvedPerimeterMap).length === 0) return
    const updatedPlaced: Record<string, PlacedBoardSlot> = { ...placedSlots }
    for (const plc of Object.values(solvedPerimeterMap)) {
      const key = `${plc.row},${plc.col}`
      updatedPlaced[key] = {
        row: plc.row,
        col: plc.col,
        piece_id: plc.piece_id,
        rotation: plc.rotation,
        placed_at: Date.now(),
      }
      await placePieceOnBoard(plc.row, plc.col, plc.piece_id, plc.rotation)
    }
    setPlacedSlots(updatedPlaced)
    setStoredPieces((prev) =>
      prev.map((p) => {
        const plc = solvedPerimeterMap[p.id]
        if (plc) {
          return {
            ...p,
            status: 'Placed',
            placed_slot: { row: plc.row, col: plc.col, rotation: plc.rotation },
          }
        }
        return p
      })
    )
    playSaveSound()
    console.log(`Applied ${Object.keys(solvedPerimeterMap).length} perimeter pieces to board.`)
  }, [solvedPerimeterMap, placedSlots, playSaveSound])

  // Rotate solved perimeter solution by 180 degrees
  const handleRotatePerimeter = useCallback(async () => {
    const curRows = posterDims.rows > 0 ? posterDims.rows : 28
    const curCols = posterDims.cols > 0 ? posterDims.cols : 36
    const maxR = curRows - 1
    const maxC = curCols - 1
    const newMap: Record<string, typeof solvedPerimeterMap[string]> = {}
    for (const [id, plc] of Object.entries(solvedPerimeterMap)) {
      const r = plc.row
      const c = plc.col
      const newR = maxR - r
      const newC = maxC - c
      const prevRot = plc.rotation
      const newRot = (prevRot + 2) % 4
      newMap[id] = {
        ...plc,
        row: newR,
        col: newC,
        rotation: newRot,
      }
    }
    setSolvedPerimeterMap(newMap)

    // Also rotate the placed perimeter slots on the board in real time
    const updatedPlaced: Record<string, PlacedBoardSlot> = {}
    for (const [key, slot] of Object.entries(placedSlots)) {
      if (newMap[slot.piece_id]) {
        const plc = newMap[slot.piece_id]
        const newKey = `${plc.row},${plc.col}`
        updatedPlaced[newKey] = {
          ...slot,
          row: plc.row,
          col: plc.col,
          rotation: plc.rotation,
        }
        await placePieceOnBoard(plc.row, plc.col, plc.piece_id, plc.rotation)
      } else {
        updatedPlaced[key] = slot
      }
    }
    setPlacedSlots(updatedPlaced)
    playSaveSound()
    console.log('Perimeter solution and board placements rotated 180 degrees.')
  }, [posterDims, solvedPerimeterMap, placedSlots, playSaveSound])

  // Rotate master reference poster by 90 or 180 degrees
  const handleRotatePoster = useCallback((deg: 90 | 180) => {
    if (!posterRgba || posterDims.w <= 0 || posterDims.h <= 0) return
    const srcW = posterDims.w
    const srcH = posterDims.h
    const dstW = deg === 90 ? srcH : srcW
    const dstH = deg === 90 ? srcW : srcH

    const srcCanvas = document.createElement('canvas')
    srcCanvas.width = srcW
    srcCanvas.height = srcH
    const srcCtx = srcCanvas.getContext('2d')
    if (!srcCtx) return
    const srcImgData = srcCtx.createImageData(srcW, srcH)
    srcImgData.data.set(posterRgba)
    srcCtx.putImageData(srcImgData, 0, 0)

    const off = document.createElement('canvas')
    off.width = dstW
    off.height = dstH
    const ctx = off.getContext('2d')
    if (!ctx) return

    ctx.save()
    ctx.translate(dstW / 2, dstH / 2)
    ctx.rotate((deg * Math.PI) / 180)
    ctx.drawImage(srcCanvas, -srcW / 2, -srcH / 2)
    ctx.restore()

    const newImgData = ctx.getImageData(0, 0, dstW, dstH)
    const newBytes = new Uint8Array(newImgData.data.buffer)
    setPosterRgba(newBytes)
    const newCols = deg === 90 ? posterDims.rows : posterDims.cols
    const newRows = deg === 90 ? posterDims.cols : posterDims.rows
    setPosterDims((prev) => ({
      ...prev,
      w: dstW,
      h: dstH,
      cols: newCols,
      rows: newRows,
    }))
    try {
      init_master_poster_spatial(newBytes, dstW, dstH, newCols, newRows)
      console.log(`Poster rotated ${deg} deg. Re-initialized master (${newCols}x${newRows}).`)
    } catch (err) {
      console.error('Failed to reinitialize rotated poster in WASM:', err)
    }
  }, [posterRgba, posterDims])

  // Fast Placement directly by clicking on board slot
  const handleSlotClick = useCallback(async (row: number, col: number) => {
    let pieceIdToPlace: string | null = null
    let rotationQuarter = 0

    if (activePlacementPiece) {
      pieceIdToPlace = activePlacementPiece.id
    } else if (identifiedPieceMatch?.is_matched) {
      pieceIdToPlace = identifiedPieceMatch.piece_id
    } else if (detectedPiece || (lastValidPieceRef.current && (performance.now() - lastValidPieceRef.current.timestamp < 1500))) {
      const targetPiece = detectedPiece || lastValidPieceRef.current?.piece
      if (targetPiece) {
        let thumbUrl = ''
        if (pieceCanvasRef.current) {
          thumbUrl = pieceCanvasRef.current.toDataURL('image/jpeg', 0.88)
        }
        const flatCount = targetPiece.edges.filter((e) => e.edge_type === 'Flat').length
        const tabCount = targetPiece.edges.filter((e) => e.edge_type === 'Tab').length
        const holeCount = targetPiece.edges.filter((e) => e.edge_type === 'Hole').length
        const classification: 'Corner' | 'Border' | 'Interior' =
          flatCount === 2 ? 'Corner' : flatCount === 1 ? 'Border' : 'Interior'
        const nextNum = storedPieces.length + 1
        const newPiece: StoredPiece = {
          id: `piece_${Date.now()}_${nextNum}`,
          piece_number: nextNum,
          timestamp: Date.now(),
          thumbnailDataUrl: thumbUrl,
          corners: [
            { ...targetPiece.corners[0] },
            { ...targetPiece.corners[1] },
            { ...targetPiece.corners[2] },
            { ...targetPiece.corners[3] },
          ],
          edges: targetPiece.edges.map((e) => ({
            edge_type: e.edge_type,
            start_corner: { ...e.start_corner },
            end_corner: { ...e.end_corner },
            curvature_depth: e.curvature_depth,
            curve_samples: e.curve_samples ? e.curve_samples.map((p) => ({ ...p })) : [],
            normalized_profile: Array.from(e.normalized_profile || getOrComputeNormalizedProfile(e)),
          })) as any,
          bounding_width_px: targetPiece.bounding_width,
          bounding_height_px: targetPiece.bounding_height,
          metric_width_mm: targetPiece.bounding_width * (96.0 / 384.0),
          metric_height_mm: targetPiece.bounding_height * (96.0 / 384.0),
          classification,
          flat_count: flatCount,
          tab_count: tabCount,
          hole_count: holeCount,
          status: 'InTray',
          placed_slot: null,
          is_favorite: false,
          tags: [],
          paired_piece_id: null,
        }
        await savePiece(newPiece)
        setStoredPieces((prev) => [newPiece, ...prev])
        pieceIdToPlace = newPiece.id
      }
    }

    if (pieceIdToPlace) {
      const cand = candidateMatches.find((c) => c.row === row && c.col === col)
      if (cand) {
        rotationQuarter = Math.round(cand.rotation_deg / 90) % 4
      } else if (solvedPerimeterMap[pieceIdToPlace]) {
        const plc = solvedPerimeterMap[pieceIdToPlace]
        if (plc.row === row && plc.col === col) {
          rotationQuarter = plc.rotation
        }
      }

      await handlePlacePiece(row, col, pieceIdToPlace, rotationQuarter)
      setSaveFeedback(`PLACED AT [R${row}, C${col}]`)
      setTimeout(() => setSaveFeedback(null), 2000)
      setActivePlacementPiece(null)
      setIdentifiedPieceMatch(null)
      setSelectedBoardSlot({ row, col })
    } else {
      setSelectedBoardSlot((prev) =>
        prev?.row === row && prev?.col === col ? null : { row, col }
      )
    }
  }, [
    activePlacementPiece,
    identifiedPieceMatch,
    detectedPiece,
    storedPieces,
    candidateMatches,
    solvedPerimeterMap,
    handlePlacePiece,
  ])

  // Fast Placement directly from live camera stage candidate
  const handlePlaceCandidate = async (cand: { col: number; row: number; rotation_deg: number }) => {
    const pieceToPlace = (isGtMode && gtFrozenPiece) ? gtFrozenPiece : detectedPiece
    if (!pieceToPlace) return

    let thumbUrl = ''
    if (pieceCanvasRef.current) {
      thumbUrl = pieceCanvasRef.current.toDataURL('image/jpeg', 0.88)
    }

    const flatCount = pieceToPlace.edges.filter((e) => e.edge_type === 'Flat').length
    const tabCount = pieceToPlace.edges.filter((e) => e.edge_type === 'Tab').length
    const holeCount = pieceToPlace.edges.filter((e) => e.edge_type === 'Hole').length
    const classification: 'Corner' | 'Border' | 'Interior' =
      pieceToPlace.is_corner || flatCount >= 2
        ? 'Corner'
        : pieceToPlace.is_border || flatCount === 1
          ? 'Border'
          : 'Interior'

    const mmPerPx = 96.0 / 384.0
    const metricW = pieceToPlace.bounding_width * mmPerPx
    const metricH = pieceToPlace.bounding_height * mmPerPx

    const now = Date.now()
    const nextPieceNum = storedPieces.length + 1
    const pieceId = `piece_${now}_${nextPieceNum}`

    // Map rotation_deg (0, 90, 180, 270) to board rotation index (0, 1, 2, 3)
    const rotIdx = Math.round(cand.rotation_deg / 90) % 4
    const targetRow = cand.row
    const targetCol = cand.col

    const stored: StoredPiece = {
      id: pieceId,
      piece_number: nextPieceNum,
      timestamp: now,
      thumbnailDataUrl: thumbUrl,
      corners: [
        { ...pieceToPlace.corners[0] },
        { ...pieceToPlace.corners[1] },
        { ...pieceToPlace.corners[2] },
        { ...pieceToPlace.corners[3] },
      ],
      edges: pieceToPlace.edges.map((e) => ({
        edge_type: e.edge_type,
        start_corner: { ...e.start_corner },
        end_corner: { ...e.end_corner },
        curvature_depth: e.curvature_depth,
        curve_samples: e.curve_samples ? e.curve_samples.map((p) => ({ ...p })) : [],
      })) as any,
      bounding_width_px: pieceToPlace.bounding_width,
      bounding_height_px: pieceToPlace.bounding_height,
      metric_width_mm: metricW,
      metric_height_mm: metricH,
      classification,
      flat_count: flatCount,
      tab_count: tabCount,
      hole_count: holeCount,
      status: 'Placed',
      placed_slot: { row: targetRow, col: targetCol, rotation: rotIdx },
      is_favorite: false,
      tags: [],
      paired_piece_id: null,
    }

    const newPlacedSlot: PlacedBoardSlot = {
      row: targetRow,
      col: targetCol,
      piece_id: pieceId,
      rotation: rotIdx,
      placed_at: now,
    }

    const updatedPlacedSlots = {
      ...placedSlots,
      [`${targetRow},${targetCol}`]: newPlacedSlot,
    }

    // Instant optimistic UI snap (0ms perceptual lag):
    setStoredPieces(prev => [stored, ...prev])
    setPlacedSlots(updatedPlacedSlots)
    setSelectedBoardSlot({ row: targetRow, col: targetCol })
    setActivePosterMatch(null)
    recentMatchesRef.current = []

    // Non-blocking background save & local neighbor sync:
    savePiece(stored).catch(e => console.error('Background savePiece error:', e))
    placePieceOnBoard(targetRow, targetCol, pieceId, rotIdx).catch(e => console.error('Background placePiece error:', e))
    syncLocalMatingPairs(targetRow, targetCol, posterDims.rows, posterDims.cols, updatedPlacedSlots, [stored, ...storedPieces])
      .then(newPairs => {
        if (newPairs.length > 0) {
          setPairedFixtures(prev => [...prev, ...newPairs])
        }
      })
      .catch(e => console.error('Background syncLocalMatingPairs error:', e))
  }

  const handlePlaceDetectedCandidate = async () => {
    if (activePosterMatch) {
      handlePlaceCandidate({
        col: activePosterMatch.best_col,
        row: activePosterMatch.best_row,
        rotation_deg: activePosterMatch.best_rotation_deg,
      })
    }
  }

  const handleUnplacePiece = async (row: number, col: number) => {
    // Optimistic UI unplacement (0ms lag)
    setPlacedSlots((prev) => {
      const copy = { ...prev }
      delete copy[`${row},${col}`]
      return copy
    })
    await unplacePieceFromBoard(row, col).catch((err) => console.error('Failed to unplace piece:', err))
  }


  // Export / Import fixtures (with Phase 8 ground-truth mating pair filtering)
  const handleExportFixtures = async () => {
    const onlyVerified = window.confirm(
      'Export verified ground-truth mating pairs only?\n\n' +
      '[OK] = Export only human-verified pairs (recommended for Phase 9 test suite)\n' +
      '[Cancel] = Include provisional auto-detected pairs'
    )

    const bundle = await exportAssemblyDataset({
      rows: posterDims.rows,
      cols: posterDims.cols,
      physical_width_mm: 700,
      physical_height_mm: 500,
    })

    if (onlyVerified) {
      bundle.paired_fixtures = bundle.paired_fixtures.filter(f => f.status === 'verified')
    }

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mating_pairs_dataset_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFixtures = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const bundle = JSON.parse(text)
        await importAssemblyDataset(bundle)
        await refreshStorage()
        alert(`Successfully imported ${bundle.pieces?.length || 0} pieces and ${Object.keys(bundle.placed_slots || {}).length} board placements!`)
      } catch (err: any) {
        alert(`Failed to import dataset: ${err.message}`)
      }
    }
    input.click()
  }

  // Freeze current piece into ground truth workbench
  const handleFreezeGroundTruth = () => {
    if (!detectedPiece) return
    if (latestDewarpedRef.current) {
      gtFrozenPixelsRef.current = new Uint8Array(latestDewarpedRef.current)
    }
    setGtFrozenPiece(detectedPiece)
    // Deep-copy corners into both the editable label AND the immutable detected snapshot
    const frozenCorners = detectedPiece.corners.map(c => ({ ...c })) as [Point2D, Point2D, Point2D, Point2D]
    setGtCorners(frozenCorners)
    setGtDetectedCorners(frozenCorners.map(c => ({ ...c })) as [Point2D, Point2D, Point2D, Point2D])
    setGtEdges(detectedPiece.edges.map(e => e.edge_type) as ['Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole', 'Flat' | 'Tab' | 'Hole'])
    setIsGtMode(true)
    setGtSaveStatus(null)
  }

  const handleExitGtMode = () => {
    setIsGtMode(false)
    gtFrozenPixelsRef.current = null
    setGtFrozenPiece(null)
    setGtCorners(null)
    setGtDetectedCorners(null)
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
      // Store the original CV-detected corners so we can audit detection accuracy per-fixture
      detected_corners: gtDetectedCorners ?? gtCorners,
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
        setGtSaveStatus(`Saved as ${result.file}`)
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

  // Keyboard shortcuts:
  // - [S] or [Space] (when not in GT mode): Save current detected piece to inventory
  // - [G]: Freeze current piece into Ground Truth workbench
  // - [Space] (in GT mode): Save ground-truth annotations
  // - [Esc] (in GT mode): Cancel ground-truth mode
  // - [Enter]: Place Drop-to-Locate piece or best candidate onto board
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return

      const isS = e.code === 'KeyS' || e.key === 's' || e.key === 'S'
      const isSpace = e.code === 'Space'
      const isG = e.code === 'KeyG' || e.key === 'g' || e.key === 'G'

      if (isS || (isSpace && !isGtMode)) {
        e.preventDefault()
        handleRecordPiece()
      } else if (isSpace && isGtMode) {
        e.preventDefault()
        handleSaveGroundTruth()
      } else if (isG && !isGtMode) {
        e.preventDefault()
        if (detectedPiece) {
          handleFreezeGroundTruth()
        }
      } else if (e.code === 'Escape') {
        if (isCalibratingFullScreen) {
          e.preventDefault()
          setIsCalibratingFullScreen(false)
          return
        }
        if (inspectedPiece) {
          e.preventDefault()
          setInspectedPiece(null)
          return
        }
        if (activePlacementPiece) {
          e.preventDefault()
          setActivePlacementPiece(null)
          return
        }
        if (showResetConfirm) {
          e.preventDefault()
          setShowResetConfirm(false)
          return
        }
        if (isGtMode) {
          e.preventDefault()
          handleExitGtMode()
          return
        }
      } else if (e.code === 'Enter') {
        const idMatch = identifiedPieceMatchRef.current
        const solvedPlc = (idMatch && idMatch.is_matched) ? solvedPerimeterMapRef.current[idMatch.piece_id] : null
        if (idMatch && solvedPlc) {
          e.preventDefault()
          handlePlacePiece(solvedPlc.row, solvedPlc.col, idMatch.piece_id, solvedPlc.rotation)
          setIdentifiedPieceMatch(null)
        } else if (activePosterMatch && detectedPiece) {
          e.preventDefault()
          handlePlaceDetectedCandidate()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCalibratingFullScreen, detectedPiece, isGtMode, gtFrozenPiece, gtCorners, gtEdges, activePosterMatch, handlePlaceDetectedCandidate, handlePlacePiece, handleRecordPiece, handleFreezeGroundTruth, handleSaveGroundTruth, handleExitGtMode])


  return (
    <div className="app-container">
      {/* Top Navigation Bar: Board, Piece Tray, Grid Info, Start Fresh */}
      <div
        className="app-top-nav"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 14px',
          background: '#161b22',
          borderBottom: '1px solid #30363d',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className={`tab-pill-btn ${activeTopView === 'board' ? 'active' : ''}`}
            onClick={() => setActiveTopView('board')}
          >
            BOARD
          </button>
          <button
            type="button"
            className={`tab-pill-btn ${activeTopView === 'tray' ? 'active' : ''}`}
            onClick={() => setActiveTopView('tray')}
          >
            PIECE TRAY ({storedPieces.length})
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, color: '#8b949e' }}>
            GRID: <b>{posterDims.cols} × {posterDims.rows} ({posterDims.cols * posterDims.rows})</b>
          </span>
          <button
            className="btn small danger"
            style={{ padding: '3px 8px', fontSize: 10, background: '#21262d', borderColor: '#da3633', color: '#f85149' }}
            onClick={() => setShowResetConfirm(true)}
            title="Reset application and start completely fresh"
          >
            START FRESH
          </button>
        </div>
      </div>

      {/* Camera Calibration Full-Screen Modal or Background Container */}
      <div
        style={
          isCalibratingFullScreen
            ? {
                position: 'fixed',
                inset: 0,
                zIndex: 99999,
                background: '#090d13',
                display: 'flex',
                flexDirection: 'column',
              }
            : {
                position: 'fixed',
                width: 1,
                height: 1,
                opacity: 0.001,
                pointerEvents: 'none',
                top: 0,
                left: 0,
                zIndex: -1,
                overflow: 'hidden',
              }
        }
      >
        {isCalibratingFullScreen && (
          <div
            style={{
              padding: '10px 16px',
              background: '#161b22',
              borderBottom: '1px solid #30363d',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#f0f6fc' }}>
                CAMERA CALIBRATION
              </span>
              <span style={{ fontSize: 12, color: '#8b949e' }}>
                FOCUS: <b style={{ color: focusScore >= 40 ? '#3fb950' : focusScore >= 20 ? '#d29922' : '#f85149' }}>{focusScore.toFixed(0)}%</b>
              </span>
              <span style={{ fontSize: 11, color: isCameraActive ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                {isCameraActive ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              <button
                className="btn small primary"
                style={{ background: '#238636', borderColor: '#2ea043', fontWeight: 700, padding: '6px 14px' }}
                onClick={() => setIsCalibratingFullScreen(false)}
              >
                DONE
              </button>
            </div>
          </div>
        )}

        <div
          style={
            isCalibratingFullScreen
              ? {
                  flex: 1,
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: '#04070a',
                  overflow: 'hidden',
                  padding: 12,
                }
              : { display: 'block' }
          }
        >
          <video
            ref={videoRef}
            playsInline
            muted
            className={`camera-video ${isMirror ? 'mirrored' : ''}`}
            style={
              isCalibratingFullScreen
                ? {
                    maxWidth: '96vw',
                    maxHeight: '84vh',
                    objectFit: 'contain',
                    display: isCameraActive ? 'block' : 'none',
                  }
                : undefined
            }
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
          <canvas
            ref={overlayCanvasRef}
            className={`camera-overlay ${isMirror ? 'mirrored' : ''}`}
            style={
              isCalibratingFullScreen
                ? {
                    maxWidth: '96vw',
                    maxHeight: '84vh',
                    objectFit: 'contain',
                    display: isCameraActive ? 'block' : 'none',
                  }
                : undefined
            }
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />

          {isCalibratingFullScreen && !isCameraActive && (
            <div className="camera-empty">
              {cameraError ? <span className="red">{cameraError}</span> : <span>Camera is inactive.</span>}
              <button className="btn primary" onClick={startCamera}>START CAMERA</button>
            </div>
          )}

          {isCalibratingFullScreen && (
            <div
              style={{
                position: 'absolute',
                bottom: 16,
                background: 'rgba(22, 27, 34, 0.9)',
                border: '1px solid #30363d',
                borderRadius: 6,
                padding: '6px 14px',
                fontSize: 12,
                color: '#8b949e',
                pointerEvents: 'none',
              }}
            >
              Drag corners C1–C4 to match the 4 fiducials on the mat. Click DONE or press ESC when finished.
            </div>
          )}
        </div>
      </div>

      {/* Main View: Board View (Workbench) or Full-Width Piece Tray */}
      {activeTopView === 'board' ? (
        <main className="main-workbench">
          {/* Left Column: Dewarp Stage */}
          <section className="workbench-panel" style={{ borderRight: '1px solid var(--border)' }}>
            <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: '#f0f6fc', letterSpacing: 0.5 }}>
                  DEWARP STAGE
                </span>
                {gtSavedCount > 0 && (
                  <span className="badge" style={{ background: '#2b6cb0', color: '#fff', fontSize: 9 }}>
                    GT #{gtSavedCount}
                  </span>
                )}
              </div>

              <div className="panel-actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  className="btn small"
                  style={{ background: '#21262d', borderColor: '#388bfd', color: '#58a6ff', fontWeight: 600 }}
                  onClick={() => setIsCalibratingFullScreen(true)}
                  title="Open full-screen camera view and fiducial calibration"
                >
                  CALIBRATE CAMERA
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ color: isCameraActive ? '#3fb950' : '#f85149', fontWeight: 600 }}>
                    {isCameraActive ? 'LIVE' : 'OFFLINE'}
                  </span>
                  <span style={{ color: '#8b949e' }}>
                    FOCUS: <b style={{ color: focusScore >= 40 ? '#3fb950' : focusScore >= 20 ? '#d29922' : '#f85149' }}>{focusScore.toFixed(0)}%</b>
                  </span>
                </div>
              </div>
            </div>

            <div className="panel-view" style={{ minHeight: 280, maxHeight: '48vh', flex: 1, background: '#090d13', position: 'relative', overflow: 'hidden' }}>
              <div
                style={{
                  display: 'flex',
                  width: '100%',
                  height: '100%',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexDirection: 'column',
                  position: 'relative',
                  padding: 8,
                }}
              >
                <canvas
                  ref={pieceCanvasRef}
                  width={384}
                  height={384}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    aspectRatio: '1 / 1',
                    objectFit: 'contain',
                    borderRadius: 8,
                    border: detectedPiece ? '2px solid #2ea043' : '2px solid #30363d',
                    boxShadow: detectedPiece ? '0 0 20px rgba(46, 160, 67, 0.25)' : '0 4px 16px rgba(0, 0, 0, 0.6)',
                    background: '#0d1117',
                    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
                  }}
                />

                {!isCameraActive && (
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(13, 17, 23, 0.85)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    borderRadius: 8,
                  }}>
                    <span style={{ color: '#8b949e', fontSize: 13 }}>Camera is offline</span>
                    <button className="btn primary" onClick={startCamera}>START CAMERA</button>
                  </div>
                )}

                {isCameraActive && !detectedPiece && !lastValidPieceRef.current && (
                  <div style={{
                    position: 'absolute',
                    bottom: 14,
                    background: 'rgba(22, 27, 34, 0.88)',
                    backdropFilter: 'blur(4px)',
                    border: '1px solid #30363d',
                    borderRadius: 20,
                    padding: '4px 12px',
                    fontSize: 11,
                    color: '#8b949e',
                    pointerEvents: 'none',
                  }}>
                    Place piece on 100mm mat stage
                  </div>
                )}
              </div>
            </div>

            {/* Staged Piece Diagnostics & Fast Placement */}
            <div className="panel-body" style={{ padding: 10, gap: 8, alignItems: 'stretch' }}>
              {!isGtMode ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%', justifyContent: 'space-between' }}>
                  <div className="piece-data-card" style={{ width: '100%', maxWidth: 'none', padding: 8 }}>
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
                      <span className="data-label">EDGES:</span>
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

                  {/* Primary Action Controls: Prominent, zero-scroll Save Piece + GT */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 'auto' }}>
                    <button
                      className="btn primary"
                      style={{
                        background: detectedPiece || lastValidPieceRef.current ? '#238636' : '#21262d',
                        borderColor: detectedPiece || lastValidPieceRef.current ? '#2ea043' : '#30363d',
                        color: detectedPiece || lastValidPieceRef.current ? '#ffffff' : '#8b949e',
                        padding: '10px 14px',
                        fontSize: 13,
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        cursor: detectedPiece || lastValidPieceRef.current ? 'pointer' : 'not-allowed',
                        boxShadow: detectedPiece || lastValidPieceRef.current ? '0 2px 8px rgba(35, 134, 54, 0.4)' : 'none',
                        transition: 'all 0.15s ease',
                      }}
                      disabled={!detectedPiece && !lastValidPieceRef.current}
                      onClick={handleRecordPiece}
                      title="Save detected piece to inventory (Shortcut: S or SPACE)"
                    >
                      {saveFeedback ? (
                        <span style={{ color: '#56d364', fontWeight: 'bold' }}>{saveFeedback}</span>
                      ) : detectedPiece || lastValidPieceRef.current ? (
                        <>
                          <span>SAVE PIECE #{storedPieces.length + 1}</span>
                          <span style={{
                            fontSize: 10,
                            background: '#196c2e',
                            color: '#fff',
                            padding: '2px 6px',
                            borderRadius: 3,
                            letterSpacing: 0.5,
                          }}>
                            [S] or [SPACE]
                          </span>
                        </>
                      ) : (
                        <span style={{ fontSize: 12 }}>PLACE PIECE ON MAT TO SCAN</span>
                      )}
                    </button>

                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn"
                        style={{
                          flex: 1,
                          background: '#1a365d',
                          borderColor: '#3182ce',
                          color: '#63b3ed',
                          fontSize: 10,
                          padding: '6px 8px',
                          fontWeight: 600,
                        }}
                        disabled={!detectedPiece}
                        onClick={handleFreezeGroundTruth}
                        title="Freeze corners to label ground truth [G]"
                      >
                        LABEL GT [G]
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    Drag <b>cyan pins (C1..C4)</b> on preview:
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, background: '#161b22', padding: 4, borderRadius: 4, border: '1px solid var(--border)' }}>
                    {gtCorners && gtCorners.map((pt, i) => (
                      <div
                        key={i}
                        onClick={() => setDraggingGtCorner(draggingGtCorner === i ? null : i)}
                        style={{
                          padding: '3px 5px',
                          background: draggingGtCorner === i ? '#00e5ff22' : '#21262d',
                          border: `1px solid ${draggingGtCorner === i ? '#00e5ff' : 'var(--border)'}`,
                          borderRadius: 3,
                          cursor: 'pointer',
                          fontSize: 9,
                          display: 'flex',
                          justifyContent: 'space-between',
                        }}
                      >
                        <b style={{ color: draggingGtCorner === i ? '#00e5ff' : 'var(--text)' }}>C{i + 1}</b>
                        <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>({pt.x.toFixed(0)}, {pt.y.toFixed(0)})</span>
                      </div>
                    ))}
                  </div>

                  <div className="gt-edge-list">
                    {gtEdges.map((type, idx) => (
                      <div key={idx} className={`gt-edge-item ${type.toLowerCase()}`} style={{ padding: '3px 6px' }}>
                        <span className="gt-edge-label" style={{ fontSize: 10 }}>E{idx + 1}:</span>
                        <div className="gt-edge-toggle">
                          {(['Tab', 'Hole', 'Flat'] as const).map((t) => (
                            <button
                              key={t}
                              className={`gt-edge-btn ${type === t ? `active ${t.toLowerCase()}` : ''}`}
                              onClick={() => handleToggleEdgeType(idx, t)}
                              style={{ padding: '2px 5px', fontSize: 9 }}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {gtSaveStatus && (
                    <div style={{ fontSize: 10, textAlign: 'center', color: gtSaveStatus.startsWith('Saved') ? '#38a169' : '#e53e3e' }}>
                      {gtSaveStatus}
                    </div>
                  )}

                  <div className="gt-actions" style={{ marginTop: 4 }}>
                    <button className="btn small" onClick={handleExitGtMode}>
                      CANCEL [ESC]
                    </button>
                    <button className="btn small primary" onClick={handleSaveGroundTruth}>
                      SAVE [SPACE]
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Right Column: Assembly Board */}
          <section className="workbench-panel center-panel" style={{ flex: 1, minHeight: 0 }}>
            {activePlacementPiece && (
              <div
                style={{
                  background: '#1f6feb',
                  color: '#fff',
                  padding: '7px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  fontWeight: 600,
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
                  zIndex: 10,
                }}
              >
                <span>
                  PLACING PIECE #{activePlacementPiece.piece_number} ({activePlacementPiece.classification.toUpperCase()}) — CLICK ANY SLOT ON BOARD TO PLACE
                </span>
                <button
                  className="btn small"
                  style={{ background: '#0d1117', color: '#f0f6fc', border: '1px solid #30363d', padding: '2px 8px', fontWeight: 600 }}
                  onClick={() => setActivePlacementPiece(null)}
                >
                  CANCEL
                </button>
              </div>
            )}
            <BoardView
              rows={posterDims.rows > 0 ? posterDims.rows : 28}
              cols={posterDims.cols > 0 ? posterDims.cols : 36}
              pieces={storedPieces}
              placedSlots={placedSlots}
              pairedFixtures={pairedFixtures}
              onPlacePiece={handlePlacePiece}
              onUnplacePiece={handleUnplacePiece}
              selectedSlot={selectedBoardSlot}
              onSelectSlot={setSelectedBoardSlot}
              onSlotClick={handleSlotClick}
              onRotatePerimeter={handleRotatePerimeter}
              onRotatePoster={handleRotatePoster}
              onUpdatePairStatus={handleUpdatePairStatus}
              posterRgba={posterRgba}
              posterWidth={posterDims.w}
              posterHeight={posterDims.h}
              posterFileName={posterFileName}
              physWidthMm={physDims.wMm}
              physHeightMm={physDims.hMm}
              onExportFixtures={handleExportFixtures}
              onImportFixtures={handleImportFixtures}
              candidateMatches={candidateMatches}
              onDeletePiece={handleDeletePiece}
              onResetApplication={() => setShowResetConfirm(true)}
              onSelectPiecePreview={(piece) => setInspectedPiece(piece)}
              highlightedSlot={
                identifiedPieceMatch && solvedPerimeterMap[identifiedPieceMatch.piece_id]
                  ? {
                      row: solvedPerimeterMap[identifiedPieceMatch.piece_id].row,
                      col: solvedPerimeterMap[identifiedPieceMatch.piece_id].col,
                    }
                  : null
              }
              onSolvePerimeter={handleSolvePerimeter}
              onApplyPerimeter={handleApplyPerimeterToBoard}
              solvedPerimeterCount={Object.keys(solvedPerimeterMap).length}
              totalPerimeterCount={
                2 * ((posterDims.rows > 0 ? posterDims.rows : 28) - 2) +
                2 * ((posterDims.cols > 0 ? posterDims.cols : 36) - 2) + 4
              }
              onUpdateDimensions={(newCols, newRows, newWidthMm, newHeightMm) => {
                localStorage.setItem('jigsaw_grid_cols', newCols.toString())
                localStorage.setItem('jigsaw_grid_rows', newRows.toString())
                localStorage.setItem('jigsaw_phys_w', newWidthMm.toString())
                localStorage.setItem('jigsaw_phys_h', newHeightMm.toString())
                setPosterDims((prev) => ({ ...prev, cols: newCols, rows: newRows }))
                setPhysDims({ wMm: newWidthMm, hMm: newHeightMm })
                if (posterRgba && posterDims.w > 0 && posterDims.h > 0) {
                  try {
                    init_master_poster_spatial(posterRgba, posterDims.w, posterDims.h, newCols, newRows)
                    console.log(`Updated grid to ${newCols}x${newRows} (${newCols * newRows} pieces)`)
                  } catch (e) {
                    console.error(e)
                  }
                }
              }}
              onPosterIngested={(img, file) => {
                const detectedCols = posterDims.cols > 0 ? posterDims.cols : 36
                const detectedRows = posterDims.rows > 0 ? posterDims.rows : 28
                setPosterFileName(file.name)
                setPosterDims({
                  w: img.naturalWidth,
                  h: img.naturalHeight,
                  cols: detectedCols,
                  rows: detectedRows,
                })
                const off = document.createElement('canvas')
                off.width = img.naturalWidth
                off.height = img.naturalHeight
                const ctx = off.getContext('2d')
                if (ctx) {
                  ctx.drawImage(img, 0, 0)
                  const imgData = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight)
                  const bytes = new Uint8Array(imgData.data.buffer)
                  setPosterRgba(bytes)
                  try {
                    init_master_poster_spatial(
                      bytes,
                      img.naturalWidth,
                      img.naturalHeight,
                      detectedCols,
                      detectedRows
                    )
                    isPosterInitializedRef.current = true
                    console.log('Ingested new master poster into spatial WASM memory')
                  } catch (err) {
                    console.error('Failed to initialize spatial master poster:', err)
                  }
                }
              }}
            />
          </section>
        </main>
      ) : (
        <main style={{ flex: 1, width: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0d1117' }}>
          <PieceTray
            pieces={storedPieces}
            selectedPieceId={activePlacementPiece?.id || inspectedPiece?.id || null}
            onSelectPiece={(piece) => setInspectedPiece(piece)}
            onToggleFavorite={handleToggleFavorite}
            onDeletePiece={handleDeletePiece}
            onClearAllPieces={() => setShowResetConfirm(true)}
            slotFilter={null}
            onClearSlotFilter={() => { }}
            onPlaceOnBoard={(piece) => {
              setActivePlacementPiece(piece)
              setInspectedPiece(null)
              setActiveTopView('board')
            }}
          />
        </main>
      )}

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

      {/* Piece Detailed Inspection Modal */}
      {inspectedPiece && (
        <div className="modal-backdrop" onClick={() => setInspectedPiece(null)}>
          <div className="piece-preview-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="piece-preview-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#f0f6fc' }}>
                  PIECE #{inspectedPiece.piece_number}
                </span>
                <span className={`pill ${inspectedPiece.classification.toLowerCase()}`}>
                  {inspectedPiece.classification.toUpperCase()}
                </span>
                {inspectedPiece.is_favorite && <span style={{ color: '#e3b341', fontSize: 12 }}>FAVORITE</span>}
              </div>
              <button
                className="btn small"
                onClick={() => setInspectedPiece(null)}
                style={{ background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d' }}
              >
                CLOSE
              </button>
            </div>

            <div className="piece-preview-body">
              <div className="piece-preview-image-wrap">
                {inspectedPiece.thumbnailDataUrl ? (
                  <img
                    src={inspectedPiece.thumbnailDataUrl}
                    alt={`Piece #${inspectedPiece.piece_number}`}
                    className="piece-preview-image"
                  />
                ) : (
                  <div style={{ color: '#8b949e', fontSize: 12 }}>No image available</div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: '#21262d', padding: '8px 10px', borderRadius: 4, border: '1px solid #30363d' }}>
                  <div style={{ fontSize: 10, color: '#8b949e' }}>DIMENSIONS</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#f0f6fc', marginTop: 2 }}>
                    {inspectedPiece.metric_width_mm?.toFixed(1) || '--'} × {inspectedPiece.metric_height_mm?.toFixed(1) || '--'} mm
                  </div>
                  <div style={{ fontSize: 10, color: '#8b949e' }}>
                    ({inspectedPiece.bounding_width_px} × {inspectedPiece.bounding_height_px} px)
                  </div>
                </div>

                <div style={{ background: '#21262d', padding: '8px 10px', borderRadius: 4, border: '1px solid #30363d' }}>
                  <div style={{ fontSize: 10, color: '#8b949e' }}>BOARD STATUS</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: inspectedPiece.status === 'Placed' ? '#3fb950' : '#8b949e', marginTop: 2 }}>
                    {inspectedPiece.status === 'Placed' && inspectedPiece.placed_slot
                      ? `[R${inspectedPiece.placed_slot.row}, C${inspectedPiece.placed_slot.col}]`
                      : 'IN TRAY'}
                  </div>
                  <div style={{ fontSize: 10, color: '#8b949e' }}>
                    {inspectedPiece.status === 'Placed' ? 'Placed on Assembly Grid' : 'Unplaced Inventory'}
                  </div>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#8b949e', marginBottom: 6 }}>EDGES (N, E, S, W)</div>
                <div className="piece-preview-edges">
                  {inspectedPiece.edges.map((edge, idx) => (
                    <div key={idx} className={`piece-preview-edge-pill ${edge.edge_type.toLowerCase()}`}>
                      <span style={{ fontWeight: 600, color: '#c9d1d9' }}>
                        E{idx + 1} ({['North', 'East', 'South', 'West'][idx]}):
                      </span>
                      <span style={{ fontWeight: 700 }}>{edge.edge_type}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="piece-preview-footer">
              <button
                className="btn"
                style={{ background: '#21262d', color: '#c9d1d9', borderColor: '#30363d' }}
                onClick={() => handleToggleFavorite(inspectedPiece.id)}
              >
                {inspectedPiece.is_favorite ? 'UNFAVORITE' : 'FAVORITE'}
              </button>

              <div style={{ display: 'flex', gap: 8 }}>
                {inspectedPiece.status !== 'Placed' && (
                  <button
                    className="btn primary"
                    style={{ background: '#238636', borderColor: '#2ea043', color: '#fff', fontWeight: 700 }}
                    onClick={() => {
                      setActivePlacementPiece(inspectedPiece)
                      setInspectedPiece(null)
                      setActiveTopView('board')
                    }}
                  >
                    PLACE ON BOARD
                  </button>
                )}

                {inspectedPiece.status === 'Placed' && inspectedPiece.placed_slot && (
                  <button
                    className="btn"
                    style={{ background: '#30363d', color: '#ff7b72', borderColor: '#484f58' }}
                    onClick={() => {
                      if (inspectedPiece.placed_slot) {
                        handleUnplacePiece(inspectedPiece.placed_slot.row, inspectedPiece.placed_slot.col)
                        setInspectedPiece(null)
                      }
                    }}
                  >
                    UNPLACE
                  </button>
                )}

                <button
                  className="btn danger"
                  style={{ background: '#da3633', borderColor: '#f85149', color: '#fff' }}
                  onClick={() => {
                    if (window.confirm(`Permanently delete Piece #${inspectedPiece.piece_number}?`)) {
                      handleDeletePiece(inspectedPiece.id)
                    }
                  }}
                >
                  DELETE PIECE
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Start Fresh / Full Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="modal-backdrop" onClick={() => setShowResetConfirm(false)}>
          <div className="reset-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#f85149', display: 'flex', alignItems: 'center', gap: 8 }}>
              START FRESH &amp; RESET ALL
            </div>
            <p style={{ fontSize: 13, color: '#c9d1d9', lineHeight: 1.5, margin: '8px 0' }}>
              Are you sure you want to completely reset the application?
            </p>
            <ul style={{ fontSize: 12, color: '#8b949e', margin: '0 0 12px 18px', lineHeight: 1.6 }}>
              <li>Delete all <strong>{storedPieces.length} stored pieces</strong> from IndexedDB</li>
              <li>Clear all board slots &amp; placed pieces</li>
              <li>Reset puzzle grid to <strong>1008 pieces (36 cols × 28 rows)</strong></li>
              <li>Reset calibration and stored local storage keys</li>
            </ul>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
              <button
                className="btn"
                style={{ background: '#21262d', color: '#c9d1d9', borderColor: '#30363d' }}
                onClick={() => setShowResetConfirm(false)}
              >
                CANCEL
              </button>
              <button
                className="btn danger"
                style={{ background: '#da3633', borderColor: '#f85149', color: '#fff', fontWeight: 700 }}
                onClick={handleResetApplication}
              >
                DELETE ALL &amp; RESET
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
