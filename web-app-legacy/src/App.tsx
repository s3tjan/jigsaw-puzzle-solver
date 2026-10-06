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
  inspect_piece_pair_wasm,
} from './pkg/cv_engine'
import { BoardView } from './components/BoardView'
import type { CandidateMatchOverlay } from './components/BoardView'
import { PieceTray } from './components/PieceTray'
import type { StoredPiece, PlacedBoardSlot } from './storage/db'
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

export function extractEdgeSeamRgbSamples(
  edge: any,
  dewarpedBytes: Uint8Array | null,
  pieceCentroid: { x: number; y: number }
): [number, number, number][] {
  if (!dewarpedBytes || dewarpedBytes.length < 384 * 384 * 4) {
    return []
  }
  const samples = edge.curve_samples
  const pStart = edge.start_corner
  const pEnd = edge.end_corner
  if (!samples || samples.length === 0 || !pStart || !pEnd) {
    return []
  }

  const nS = samples.length
  const rgbSamples: [number, number, number][] = []

  for (let k = 0; k < 100; k++) {
    const t = k / 99.0
    const sampleIdx = Math.min(nS - 1, Math.round(t * (nS - 1)))
    const s = samples[sampleIdx]

    // Sample 2 pixels inward towards the piece centroid to avoid white paper mat bleed
    const toCx = pieceCentroid.x - s.x
    const toCy = pieceCentroid.y - s.y
    const distC = Math.hypot(toCx, toCy)
    const inwardDist = distC > 1.0 ? 2.0 : 0.0
    const sampleX = Math.round(Math.max(0, Math.min(383, s.x + (toCx / (distC || 1)) * inwardDist)))
    const sampleY = Math.round(Math.max(0, Math.min(383, s.y + (toCy / (distC || 1)) * inwardDist)))

    const idx = (sampleY * 384 + sampleX) * 4
    rgbSamples.push([
      dewarpedBytes[idx],
      dewarpedBytes[idx + 1],
      dewarpedBytes[idx + 2],
    ])
  }

  return rgbSamples
}

export function extractSeamRgbSamplesFromThumbnail(
  edge: any,
  imgData: ImageData,
  pieceCentroid: { x: number; y: number }
): [number, number, number][] {
  const samples = edge.curve_samples
  const pStart = edge.start_corner
  const pEnd = edge.end_corner
  if (!samples || samples.length === 0 || !pStart || !pEnd) {
    return []
  }

  const nS = samples.length
  const rgbSamples: [number, number, number][] = []
  const w = imgData.width
  const h = imgData.height
  const data = imgData.data

  for (let k = 0; k < 100; k++) {
    const t = k / 99.0
    const sampleIdx = Math.min(nS - 1, Math.round(t * (nS - 1)))
    const s = samples[sampleIdx]

    // Sample 2 pixels inward towards the piece centroid
    const toCx = pieceCentroid.x - s.x
    const toCy = pieceCentroid.y - s.y
    const distC = Math.hypot(toCx, toCy)
    const inwardDist = distC > 1.0 ? 2.0 : 0.0
    const sampleX = Math.round(Math.max(0, Math.min(w - 1, s.x + (toCx / (distC || 1)) * inwardDist)))
    const sampleY = Math.round(Math.max(0, Math.min(h - 1, s.y + (toCy / (distC || 1)) * inwardDist)))

    const idx = (sampleY * w + sampleX) * 4
    rgbSamples.push([data[idx], data[idx + 1], data[idx + 2]])
  }

  return rgbSamples
}

export function pieceToIndexedData(piece: StoredPiece) {
  const mmPerPx = 96.0 / 384.0
  return {
    id: piece.id,
    piece_number: piece.piece_number,
    classification: piece.classification,
    edges: piece.edges.map((e) => {
      let chordMm = e.chord_length_mm || 0
      let tabDepthMm = e.tab_depth_mm || 0
      let tabWidthMm = e.tab_width_mm || 0

      if (chordMm === 0 && e.start_corner && e.end_corner) {
        const dx = e.end_corner.x - e.start_corner.x
        const dy = e.end_corner.y - e.start_corner.y
        chordMm = Math.hypot(dx, dy) * mmPerPx
      }
      if (tabDepthMm === 0 && e.curvature_depth) {
        tabDepthMm = Math.abs(e.curvature_depth) * mmPerPx
      }

      return {
        edge_type: e.edge_type,
        curvature_depth: e.curvature_depth,
        normalized_profile: getOrComputeNormalizedProfile(e),
        chord_length_mm: chordMm,
        tab_depth_mm: tabDepthMm,
        tab_width_mm: tabWidthMm,
        seam_rgb_samples: e.seam_rgb_samples || [],
      }
    }),
    mean_rgb: null,
  }
}


export function createCleanPieceThumbnail(
  dewarpedBytes: Uint8Array | null,
  piece: ScannedPiece
): string {
  if (!dewarpedBytes || dewarpedBytes.length < 384 * 384 * 4) {
    return ''
  }
  const canvas = document.createElement('canvas')
  canvas.width = 384
  canvas.height = 384
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const imgData = ctx.createImageData(384, 384)
  imgData.data.set(dewarpedBytes)
  ctx.putImageData(imgData, 0, 0)

  const maskedCanvas = document.createElement('canvas')
  maskedCanvas.width = 384
  maskedCanvas.height = 384
  const mCtx = maskedCanvas.getContext('2d')
  if (!mCtx) return canvas.toDataURL('image/png')

  let contour: Point2D[] = []
  if (piece.contour_points && piece.contour_points.length >= 3) {
    contour = piece.contour_points
  } else if (piece.edges && piece.edges.length === 4) {
    for (const edge of piece.edges) {
      if (edge.curve_samples && edge.curve_samples.length > 0) {
        for (const s of edge.curve_samples) {
          contour.push(s)
        }
      } else {
        contour.push(edge.start_corner)
        contour.push(edge.end_corner)
      }
    }
  } else if (piece.corners && piece.corners.length === 4) {
    contour = [...piece.corners]
  }

  if (contour.length >= 3) {
    mCtx.beginPath()
    mCtx.moveTo(contour[0].x, contour[0].y)
    for (let i = 1; i < contour.length; i++) {
      mCtx.lineTo(contour[i].x, contour[i].y)
    }
    mCtx.closePath()
    mCtx.clip()
  }

  mCtx.drawImage(canvas, 0, 0)
  return maskedCanvas.toDataURL('image/png')
}

export default function App() {
  const [wasmReady, setWasmReady] = useState(false)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [focusScore, setFocusScore] = useState<number>(0)
  const [detectedPiece, setDetectedPiece] = useState<ScannedPiece | null>(null)

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

  // Phase 7: Pairwise Seam Inspection State & Tooling
  const [pairingSourcePieceId, setPairingSourcePieceId] = useState<string | null>(null)
  const [activeSeamInspection, setActiveSeamInspection] = useState<{
    pieceA: StoredPiece
    pieceB: StoredPiece
    details: any
    toleranceMm: number
    selectedSeamIndex: number
    saveStatus: string | null
  } | null>(null)

  // Load persistent pieces and board state from IndexedDB on startup
  const refreshStorage = useCallback(async () => {
    try {
      const [allPieces, allSlots] = await Promise.all([
        getAllPieces(),
        getAllPlacedSlots(),
      ])
      setStoredPieces(allPieces)
      setPlacedSlots(allSlots)

      // Auto-backfill seam_rgb_samples and normalized_profile for existing pieces recorded without them
      const piecesNeedingUpgrade = allPieces.filter(
        (p) =>
          p.edges.some((e) => !e.normalized_profile || e.normalized_profile.length < 10) ||
          p.edges.some((e) => !e.seam_rgb_samples || e.seam_rgb_samples.length === 0)
      )

      if (piecesNeedingUpgrade.length > 0) {
        Promise.all(
          piecesNeedingUpgrade.map(async (p) => {
            let imgData: ImageData | null = null
            if (p.thumbnailDataUrl) {
              try {
                imgData = await new Promise<ImageData | null>((resolve) => {
                  const img = new Image()
                  img.onload = () => {
                    const c = document.createElement('canvas')
                    c.width = img.width || 384
                    c.height = img.height || 384
                    const ctx = c.getContext('2d')
                    if (!ctx) return resolve(null)
                    ctx.drawImage(img, 0, 0)
                    resolve(ctx.getImageData(0, 0, c.width, c.height))
                  }
                  img.onerror = () => resolve(null)
                  img.src = p.thumbnailDataUrl
                })
              } catch {}
            }

            const pCentroid = {
              x: (p.corners[0].x + p.corners[1].x + p.corners[2].x + p.corners[3].x) / 4,
              y: (p.corners[0].y + p.corners[1].y + p.corners[2].y + p.corners[3].y) / 4,
            }

            const updated: StoredPiece = {
              ...p,
              edges: p.edges.map((e) => {
                let samples = e.seam_rgb_samples || []
                if (samples.length === 0 && imgData) {
                  samples = extractSeamRgbSamplesFromThumbnail(e, imgData, pCentroid)
                }
                return {
                  ...e,
                  normalized_profile: e.normalized_profile && e.normalized_profile.length >= 10
                    ? e.normalized_profile
                    : getOrComputeNormalizedProfile(e),
                  seam_rgb_samples: samples,
                }
              }) as any,
            }

            await savePiece(updated)
            return updated
          })
        )
          .then((upgraded) => {
            console.log(`Auto-upgraded ${upgraded.length} pieces with seam ink & profiles`)
            setStoredPieces((prev) =>
              prev.map((p) => {
                const found = upgraded.find((u) => u.id === p.id)
                return found || p
              })
            )
          })
          .catch((err) => console.warn('Upgrade backfill non-fatal error:', err))
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

          if (solvedPlc && idMatch && idMatch.is_matched) {
            hudText = `PIECE #${idMatch.piece_number} -> [R${solvedPlc.row}, C${solvedPlc.col}] (${solvedPlc.rotation * 90}°) — L2: ${idMatch.identity_distance.toFixed(4)} (${idMatch.confidence.toFixed(0)}%)`
            borderColor = '#2ea043'
            textColor = '#3fb950'
          } else if (idMatch) {
            const isMatch = idMatch.is_matched
            hudText = `PIECE #${idMatch.piece_number} (${idMatch.rotation_offset * 90}°) — L2: ${idMatch.identity_distance.toFixed(4)} ${isMatch ? `[MATCH ${idMatch.confidence.toFixed(0)}%]` : `[NO MATCH > 0.045]`}`
            borderColor = isMatch ? '#2ea043' : '#d29922'
            textColor = isMatch ? '#3fb950' : '#e3b341'
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
                    setIdentifiedPieceMatch(idMatch || null)
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

  // Ground Truth: Drag and drop corner pins on 384x384 piece canvas
  const getPieceCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>): Point2D => {
    const canvas = pieceCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return {
      x: Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * scaleY)),
    }
  }

  const handleGtPieceCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isGtMode || !gtCorners) return
    const pt = getPieceCanvasCoords(e)
    const HIT_RADIUS = 24
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(gtCorners[i].x - pt.x, gtCorners[i].y - pt.y) <= HIT_RADIUS) {
        setDraggingGtCorner(i)
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        return
      }
    }
  }

  const handleGtPieceCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isGtMode || draggingGtCorner === null || !gtCorners) return
    const pt = getPieceCanvasCoords(e)
    const updated = [...gtCorners] as [Point2D, Point2D, Point2D, Point2D]
    updated[draggingGtCorner] = pt
    setGtCorners(updated)
  }

  const handleGtPieceCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggingGtCorner !== null) {
      setDraggingGtCorner(null)
      try {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {}
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

    // Generate clean transparent contour-masked artwork thumbnail from rectified arena
    let thumbUrl = ''
    if (latestDewarpedRef.current && targetPiece) {
      thumbUrl = createCleanPieceThumbnail(latestDewarpedRef.current, targetPiece)
    }
    if (!thumbUrl && pieceCanvasRef.current) {
      thumbUrl = pieceCanvasRef.current.toDataURL('image/png')
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
    const pCentroid = {
      x: (targetPiece.corners[0].x + targetPiece.corners[1].x + targetPiece.corners[2].x + targetPiece.corners[3].x) / 4,
      y: (targetPiece.corners[0].y + targetPiece.corners[1].y + targetPiece.corners[2].y + targetPiece.corners[3].y) / 4,
    }

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
      edges: targetPiece.edges.map((e) => {
        const dx = e.end_corner.x - e.start_corner.x
        const dy = e.end_corner.y - e.start_corner.y
        const chordMm = Math.hypot(dx, dy) * mmPerPx
        const tabDepthMm = Math.abs(e.curvature_depth) * mmPerPx
        const rgbSamples = extractEdgeSeamRgbSamples(e, latestDewarpedRef.current, pCentroid)

        return {
          edge_type: e.edge_type,
          start_corner: { ...e.start_corner },
          end_corner: { ...e.end_corner },
          curvature_depth: e.curvature_depth,
          curve_samples: e.curve_samples ? e.curve_samples.map((p) => ({ ...p })) : [],
          normalized_profile: Array.from(e.normalized_profile || getOrComputeNormalizedProfile(e)),
          chord_length_mm: chordMm,
          tab_depth_mm: tabDepthMm,
          tab_width_mm: 0,
          seam_rgb_samples: rgbSamples,
        }
      }) as any,
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

    // Background asynchronous persistence
    placePieceOnBoard(row, col, pieceId, rotation).catch(err => console.error('Failed to place piece:', err))
  }

  // Phase 9: 1D Closed Perimeter Loop Solver
  const handleSolvePerimeter = useCallback(async () => {
    try {
      const curRows = posterDims.rows > 0 ? posterDims.rows : 28
      const curCols = posterDims.cols > 0 ? posterDims.cols : 36

      const indexed = storedPieces.map((p) => pieceToIndexedData(p))

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

  // Phase 7: Inspect Pairwise Seams Between Piece A and Piece B
  const handleInspectPiecePair = useCallback((pieceA: StoredPiece, pieceB: StoredPiece, tolMm = 1.5) => {
    try {
      const idxA = pieceToIndexedData(pieceA)
      const idxB = pieceToIndexedData(pieceB)
      const res = inspect_piece_pair_wasm(JSON.stringify(idxA), JSON.stringify(idxB), tolMm)
      if (res) {
        let bestIdx = 0
        if (res.best_seam && res.seams) {
          const found = res.seams.findIndex(
            (s: any) => s.edge_a_idx === res.best_seam.edge_a_idx && s.edge_b_idx === res.best_seam.edge_b_idx
          )
          if (found >= 0) bestIdx = found
        }
        setActiveSeamInspection({
          pieceA,
          pieceB,
          details: res,
          toleranceMm: tolMm,
          selectedSeamIndex: bestIdx,
          saveStatus: null,
        })
      }
    } catch (err) {
      console.error('Failed to inspect piece pair seams:', err)
      alert('Error inspecting piece pair: ' + String(err))
    }
  }, [])

  // Phase 7: Save Ground-Truth Mating Pair Fixture
  const handleSavePairFixture = useCallback(async (isTrueMate: boolean) => {
    if (!activeSeamInspection) return
    const { pieceA, pieceB, details, selectedSeamIndex } = activeSeamInspection
    const seam = details.seams[selectedSeamIndex] || details.best_seam

    const fixture = {
      timestamp: new Date().toISOString(),
      piece_a_id: pieceA.id,
      piece_a_number: pieceA.piece_number,
      piece_b_id: pieceB.id,
      piece_b_number: pieceB.piece_number,
      edge_a_idx: seam ? seam.edge_a_idx : 0,
      edge_b_idx: seam ? seam.edge_b_idx : 0,
      is_true_physical_mate: isTrueMate,
      chord_diff_mm: seam ? seam.chord_diff_mm : 0,
      tab_depth_diff_mm: seam ? seam.tab_depth_diff_mm : 0,
      l2_curve_distance: seam ? seam.l2_curve_distance : 1.0,
      combined_score: seam ? seam.combined_score : 0,
      rejection_reason: seam ? seam.rejection_reason : null,
      piece_a_data: pieceToIndexedData(pieceA),
      piece_b_data: pieceToIndexedData(pieceB),
    }

    try {
      setActiveSeamInspection((prev) => prev ? { ...prev, saveStatus: 'Saving...' } : null)
      const res = await fetch('/api/save-pair-fixture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fixture),
      })
      const result = await res.json()
      if (result.success) {
        setActiveSeamInspection((prev) => prev ? { ...prev, saveStatus: `Saved as ${result.file}` } : null)
        setTimeout(() => {
          setActiveSeamInspection((prev) => prev ? { ...prev, saveStatus: null } : null)
        }, 1500)
      } else {
        setActiveSeamInspection((prev) => prev ? { ...prev, saveStatus: `Error: ${result.error || 'Failed'}` } : null)
      }
    } catch (err: any) {
      setActiveSeamInspection((prev) => prev ? { ...prev, saveStatus: `Error: ${err.message}` } : null)
    }
  }, [activeSeamInspection])

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
        if (latestDewarpedRef.current && targetPiece) {
          thumbUrl = createCleanPieceThumbnail(latestDewarpedRef.current, targetPiece)
        }
        if (!thumbUrl && pieceCanvasRef.current) {
          thumbUrl = pieceCanvasRef.current.toDataURL('image/png')
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
    if (latestDewarpedRef.current && pieceToPlace) {
      thumbUrl = createCleanPieceThumbnail(latestDewarpedRef.current, pieceToPlace)
    }
    if (!thumbUrl && pieceCanvasRef.current) {
      thumbUrl = pieceCanvasRef.current.toDataURL('image/png')
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

    // Non-blocking background save:
    savePiece(stored).catch(e => console.error('Background savePiece error:', e))
    placePieceOnBoard(targetRow, targetCol, pieceId, rotIdx).catch(e => console.error('Background placePiece error:', e))
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


  // Export / Import fixtures and board dataset
  const handleExportFixtures = async () => {
    const bundle = await exportAssemblyDataset({
      rows: posterDims.rows,
      cols: posterDims.cols,
      physical_width_mm: physDims.wMm || 700,
      physical_height_mm: physDims.hMm || 500,
    })

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `assembly_dataset_${Date.now()}.json`
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
      const isF = e.code === 'KeyF' || e.key === 'f' || e.key === 'F'

      if (isS || (isSpace && !isGtMode)) {
        e.preventDefault()
        handleRecordPiece()
      } else if (isSpace && isGtMode) {
        e.preventDefault()
        handleSaveGroundTruth()
      } else if ((isG || isF) && !isGtMode) {
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
      <div className="app-top-nav">
        <div className="flex-row gap-6">
          <button
            type="button"
            className={`tab-pill-btn ${activeTopView === 'board' ? 'active' : ''}`}
            onClick={() => setActiveTopView('board')}
          >
            Board
          </button>
          <button
            type="button"
            className={`tab-pill-btn ${activeTopView === 'tray' ? 'active' : ''}`}
            onClick={() => setActiveTopView('tray')}
          >
            Piece Tray ({storedPieces.length})
          </button>
        </div>

        <div className="flex-row gap-12">
          <span>
            Grid: <b>{posterDims.cols} × {posterDims.rows} ({posterDims.cols * posterDims.rows})</b>
          </span>
          <button
            className="btn small danger"
            onClick={() => setShowResetConfirm(true)}
            title="Reset application and start completely fresh"
          >
            Start fresh
          </button>
        </div>
      </div>

      {/* Camera Calibration Full-Screen Modal or Background Container */}
      <div
        className={isCalibratingFullScreen ? "calibration-fullscreen-container" : "calibration-hidden-container"}
      >
        {isCalibratingFullScreen && (
          <div className="calibration-topbar">
            <div className="flex-row gap-12">
              <span className="bold">
                Camera calibration & optics
              </span>
              <span>
                Focus: <b className={focusScore >= 40 ? 'green' : focusScore >= 20 ? 'yellow' : 'red'}>{focusScore.toFixed(0)}%</b>
              </span>
              <span className={isCameraActive ? 'green' : 'red'}>
                {isCameraActive ? 'Live' : 'Offline'}
              </span>
            </div>

            <div className="flex-row gap-8 flex-wrap">
              {isCameraActive ? (
                <button className="btn" onClick={stopCamera}>Stop camera</button>
              ) : (
                <button className="btn" onClick={startCamera}>Start camera</button>
              )}
              <button
                className={`btn ${isMirror ? 'bold' : ''}`}
                onClick={() => setIsMirror(!isMirror)}
                title="Toggle horizontal mirror"
              >
                {isMirror ? 'Mirrored' : 'Mirror'}
              </button>
              <button className="btn" onClick={handleSnapAll} title="Snap fiducial corners to nearest target">
                Snap corners
              </button>

              {/* Lens K1 Distortion Slider */}
              <div className="control-group">
                <label>Lens K1:</label>
                <input
                  type="range"
                  min="-0.30"
                  max="0.30"
                  step="0.01"
                  value={lensDistortion}
                  onChange={(e) => setLensDistortion(parseFloat(e.target.value))}
                  className="w-80"
                />
                <code>{lensDistortion.toFixed(2)}</code>
                <button className="btn" onClick={() => setLensDistortion(0)} title="Reset lens distortion to 0">Reset</button>
              </div>

              {/* Sensitivity Slider */}
              <div className="control-group">
                <label>Sensitivity:</label>
                <input
                  type="range"
                  min="10"
                  max="60"
                  step="1"
                  value={sensitivity}
                  onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                  className="w-80"
                />
                <code>{sensitivity.toFixed(0)}</code>
              </div>

              <a
                href="/calibration_mat.svg"
                download="staging_mat_100mm.svg"
                className="btn"
                title="Download 100mm Target Mat SVG"
              >
                Mat SVG
              </a>

              <button
                className="btn bold"
                onClick={() => setIsCalibratingFullScreen(false)}
              >
                Done
              </button>
            </div>
          </div>
        )}

        <div
          className={isCalibratingFullScreen ? "calibration-viewport" : "calibration-viewport-hidden"}
        >
          <video
            ref={videoRef}
            playsInline
            muted
            className={`camera-video ${isMirror ? 'mirrored' : ''} ${isCalibratingFullScreen ? 'camera-video-fullscreen' : ''} ${isCalibratingFullScreen && !isCameraActive ? 'hidden' : ''}`}
          />
          <canvas ref={canvasRef} className="hidden" />
          <canvas
            ref={overlayCanvasRef}
            className={`camera-overlay ${isMirror ? 'mirrored' : ''} ${isCalibratingFullScreen ? 'camera-overlay-fullscreen' : ''} ${isCalibratingFullScreen && !isCameraActive ? 'hidden' : ''}`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />

          {isCalibratingFullScreen && !isCameraActive && (
            <div className="camera-empty">
              {cameraError ? <span className="red">{cameraError}</span> : <span>Camera is inactive.</span>}
              <button className="btn bold" onClick={startCamera}>Start camera</button>
            </div>
          )}

          {isCalibratingFullScreen && (
            <div className="calibration-help-hint">
              Drag corners C1–C4 to match the 4 fiducials on the mat. Click Done or press ESC when finished.
            </div>
          )}
        </div>
      </div>

      {/* Main View: Board View (Workbench) or Full-Width Piece Tray */}
      {activeTopView === 'board' ? (
        <main className="main-workbench">
          {/* Left Column: Dewarp Stage */}
          <section className="workbench-panel">
            <div className="panel-header">
              <div className="flex-row gap-8">
                <span>Dewarp stage</span>
                {gtSavedCount > 0 && (
                  <span className="badge">
                    (GT #{gtSavedCount})
                  </span>
                )}
              </div>

              <div className="panel-actions flex-row gap-8">
                <button
                  className="btn small"
                  onClick={() => setIsCalibratingFullScreen(true)}
                  title="Open full-screen camera view and fiducial calibration"
                >
                  Calibrate camera
                </button>
                <div className="flex-row gap-8">
                  <span className={isCameraActive ? 'green' : 'red'}>
                    {isCameraActive ? 'Live' : 'Offline'}
                  </span>
                  <span>
                    Focus: <b className={focusScore >= 40 ? 'green' : focusScore >= 20 ? 'yellow' : 'red'}>{focusScore.toFixed(0)}%</b>
                  </span>
                </div>
              </div>
            </div>

            <div className="panel-view dewarp-view">
              <div className="dewarp-canvas-box">
                <canvas
                  ref={pieceCanvasRef}
                  width={384}
                  height={384}
                  onPointerDown={handleGtPieceCanvasPointerDown}
                  onPointerMove={handleGtPieceCanvasPointerMove}
                  onPointerUp={handleGtPieceCanvasPointerUp}
                  onPointerCancel={handleGtPieceCanvasPointerUp}
                  className={`dewarp-piece-canvas ${isGtMode ? 'gt-mode' : ''} ${isGtMode && draggingGtCorner !== null ? 'dragging' : ''} ${detectedPiece && !isGtMode ? 'detected' : ''}`}
                />

                {!isCameraActive && (
                  <div className="dewarp-offline-overlay">
                    <span>Camera is offline</span>
                    <button className="btn" onClick={startCamera}>Start camera</button>
                  </div>
                )}

                {isCameraActive && !detectedPiece && !lastValidPieceRef.current && (
                  <div className="dewarp-hint-badge">
                    Place piece on 100mm mat stage
                  </div>
                )}
              </div>
            </div>

            {/* Staged Piece Diagnostics & Fast Placement */}
            <div className="panel-body p-10 gap-8">
              {!isGtMode ? (
                <div className="panel-col gap-8 flex-1">
                  <div className="piece-data-card piece-data-card-full">
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
                          <span>--</span>
                        )}
                      </div>
                    </div>

                    <div className="data-row data-row-bordered">
                      <span className="data-label">INVENTORY L2:</span>
                      <span className="data-val mono">
                        {identifiedPieceMatch ? (
                          <span className={identifiedPieceMatch.is_matched ? 'green bold' : 'yellow bold'}>
                            #{identifiedPieceMatch.piece_number} ({identifiedPieceMatch.rotation_offset * 90}°) L2={identifiedPieceMatch.identity_distance.toFixed(4)}
                            {identifiedPieceMatch.is_matched ? ' [MATCH]' : ' [>0.045]'}
                          </span>
                        ) : (
                          <span>-- (Scan pieces to inventory)</span>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* Primary Action Controls */}
                  <div className="panel-col gap-6 mt-auto">
                    <button
                      className="btn primary record-btn"
                      disabled={!detectedPiece && !lastValidPieceRef.current}
                      onClick={handleRecordPiece}
                      title="Save detected piece to inventory (Shortcut: S or SPACE)"
                    >
                      {saveFeedback ? (
                        <span className="green">{saveFeedback}</span>
                      ) : detectedPiece || lastValidPieceRef.current ? (
                        <>
                          <span>Save piece #{storedPieces.length + 1}</span>
                          <span className="ml-6">
                            [S / Space]
                          </span>
                        </>
                      ) : (
                        <span>Place piece on mat to scan</span>
                      )}
                    </button>

                    <div className="flex-row gap-6">
                      <button
                        className="btn flex-1"
                        disabled={!detectedPiece}
                        onClick={handleFreezeGroundTruth}
                        title="Freeze corners to label ground truth [F or G]"
                      >
                        Label ground truth [F / G]
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="panel-col gap-8">
                  <div className="fs-10">
                    Drag <b>cyan pins (C1..C4)</b> on preview:
                  </div>

                  <div className="gt-pin-grid">
                    {gtCorners && gtCorners.map((pt, i) => (
                      <div
                        key={i}
                        onClick={() => setDraggingGtCorner(draggingGtCorner === i ? null : i)}
                        className={`gt-pin-item ${draggingGtCorner === i ? 'active' : ''}`}
                      >
                        <b>C{i + 1}</b>
                        <span className="mono">({pt.x.toFixed(0)}, {pt.y.toFixed(0)})</span>
                      </div>
                    ))}
                  </div>

                  <div className="gt-edge-list">
                    {gtEdges.map((type, idx) => (
                      <div key={idx} className={`gt-edge-item ${type.toLowerCase()} p-4`}>
                        <span className="gt-edge-label fs-11">E{idx + 1}:</span>
                        <div className="gt-edge-toggle">
                          {(['Tab', 'Hole', 'Flat'] as const).map((t) => (
                            <button
                              key={t}
                              className={`gt-edge-btn ${type === t ? `active ${t.toLowerCase()}` : ''} p-2 fs-11`}
                              onClick={() => handleToggleEdgeType(idx, t)}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {gtSaveStatus && (
                    <div className={`fs-11 text-center ${gtSaveStatus.startsWith('Saved') ? 'green' : 'red'}`}>
                      {gtSaveStatus}
                    </div>
                  )}

                  <div className="gt-actions mt-4">
                    <button className="btn small" onClick={handleExitGtMode}>
                      Cancel [Esc]
                    </button>
                    <button className="btn small bold" onClick={handleSaveGroundTruth}>
                      Save [Space]
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Right Column: Assembly Board */}
          <section className="workbench-panel center-panel flex-1">
            {activePlacementPiece && (
              <div className="panel-sub-header">
                <span>
                  Placing piece #{activePlacementPiece.piece_number} ({activePlacementPiece.classification}) — click any slot on board to place
                </span>
                <button
                  className="btn small"
                  onClick={() => setActivePlacementPiece(null)}
                >
                  Cancel
                </button>
              </div>
            )}
            <BoardView
              rows={posterDims.rows > 0 ? posterDims.rows : 28}
              cols={posterDims.cols > 0 ? posterDims.cols : 36}
              pieces={storedPieces}
              placedSlots={placedSlots}
              onPlacePiece={handlePlacePiece}
              onUnplacePiece={handleUnplacePiece}
              selectedSlot={selectedBoardSlot}
              onSelectSlot={setSelectedBoardSlot}
              onSlotClick={handleSlotClick}
              onRotatePerimeter={handleRotatePerimeter}
              onRotatePoster={handleRotatePoster}
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
        <main className="tray-fullwidth-main">
          <PieceTray
            pieces={storedPieces}
            selectedPieceId={activePlacementPiece?.id || inspectedPiece?.id || null}
            onSelectPiece={(piece) => setInspectedPiece(piece)}
            onToggleFavorite={handleToggleFavorite}
            onDeletePiece={handleDeletePiece}
            onClearAllPieces={() => setShowResetConfirm(true)}
            slotFilter={null}
            onClearSlotFilter={() => { }}
            pairingSourcePieceId={pairingSourcePieceId}
            onStartPairingWith={(pieceId) => {
              if (!pairingSourcePieceId) {
                setPairingSourcePieceId(pieceId)
              } else {
                const pieceA = storedPieces.find((p) => p.id === pairingSourcePieceId)
                const pieceB = storedPieces.find((p) => p.id === pieceId)
                setPairingSourcePieceId(null)
                if (pieceA && pieceB) {
                  handleInspectPiecePair(pieceA, pieceB)
                }
              }
            }}
            onCancelPairing={() => setPairingSourcePieceId(null)}
            onPlaceOnBoard={(piece) => {
              setActivePlacementPiece(piece)
              setInspectedPiece(null)
              setActiveTopView('board')
            }}
          />
        </main>
      )}

      {/* Piece Detailed Inspection Modal */}
      {inspectedPiece && (
        <div className="modal-backdrop" onClick={() => setInspectedPiece(null)}>
          <div className="piece-preview-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="piece-preview-header">
              <div className="dialog-header-title">
                <span className="fs-16 bold">
                  Piece #{inspectedPiece.piece_number}
                </span>
                <span className={`pill ${inspectedPiece.classification.toLowerCase()}`}>
                  {inspectedPiece.classification}
                </span>
                {inspectedPiece.is_favorite && <span className="yellow fs-12 bold">Favorite</span>}
              </div>
              <button
                className="btn small"
                onClick={() => setInspectedPiece(null)}
              >
                Close
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
                  <div className="fs-12">No image available</div>
                )}
              </div>

              <div className="two-col-grid">
                <div className="stat-cell">
                  <div className="label-text">Dimensions</div>
                  <div className="val-text">
                    {inspectedPiece.metric_width_mm?.toFixed(1) || '--'} × {inspectedPiece.metric_height_mm?.toFixed(1) || '--'} mm
                  </div>
                  <div className="val-subtext">
                    ({inspectedPiece.bounding_width_px} × {inspectedPiece.bounding_height_px} px)
                  </div>
                </div>

                <div className="stat-cell">
                  <div className="label-text">Board status</div>
                  <div className={`val-text ${inspectedPiece.status === 'Placed' ? 'green' : ''}`}>
                    {inspectedPiece.status === 'Placed' && inspectedPiece.placed_slot
                      ? `[R${inspectedPiece.placed_slot.row}, C${inspectedPiece.placed_slot.col}]`
                      : 'In tray'}
                  </div>
                  <div className="val-subtext">
                    {inspectedPiece.status === 'Placed' ? 'Placed on Assembly Grid' : 'Unplaced Inventory'}
                  </div>
                </div>
              </div>

              <div>
                <div className="label-text bold mb-6">Edges (North, East, South, West)</div>
                <div className="piece-preview-edges">
                  {inspectedPiece.edges.map((edge, idx) => (
                    <div key={idx} className={`piece-preview-edge-pill ${edge.edge_type.toLowerCase()}`}>
                      <span className="bold">
                        E{idx + 1} ({['North', 'East', 'South', 'West'][idx]}):
                      </span>
                      <span className="bold">{edge.edge_type}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="piece-preview-footer">
              <button
                className="btn"
                onClick={() => handleToggleFavorite(inspectedPiece.id)}
              >
                {inspectedPiece.is_favorite ? 'Unfavorite' : 'Favorite'}
              </button>

              <div className="flex-row gap-8">
                <button
                  className="btn bold"
                  onClick={() => {
                    const srcId = inspectedPiece.id
                    setInspectedPiece(null)
                    setPairingSourcePieceId(srcId)
                    setActiveTopView('tray')
                  }}
                  title="Select another piece to diagnostically inspect pairwise seam fit"
                >
                  Pair with another...
                </button>

                {inspectedPiece.status !== 'Placed' && (
                  <button
                    className="btn primary bold"
                    onClick={() => {
                      setActivePlacementPiece(inspectedPiece)
                      setInspectedPiece(null)
                      setActiveTopView('board')
                    }}
                  >
                    Place on board
                  </button>
                )}

                {inspectedPiece.status === 'Placed' && inspectedPiece.placed_slot && (
                  <button
                    className="btn"
                    onClick={() => {
                      if (inspectedPiece.placed_slot) {
                        handleUnplacePiece(inspectedPiece.placed_slot.row, inspectedPiece.placed_slot.col)
                        setInspectedPiece(null)
                      }
                    }}
                  >
                    Unplace
                  </button>
                )}

                <button
                  className="btn danger"
                  onClick={() => {
                    if (window.confirm(`Permanently delete Piece #${inspectedPiece.piece_number}?`)) {
                      handleDeletePiece(inspectedPiece.id)
                    }
                  }}
                >
                  Delete piece
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
            <div className="dialog-header-title red fs-16 bold">
              Start fresh &amp; reset all
            </div>
            <p className="fs-13">
              Are you sure you want to completely reset the application?
            </p>
            <ul className="fs-12">
              <li>Delete all <strong>{storedPieces.length} stored pieces</strong> from IndexedDB</li>
              <li>Clear all board slots &amp; placed pieces</li>
              <li>Reset puzzle grid to <strong>1008 pieces (36 cols × 28 rows)</strong></li>
              <li>Reset calibration and stored local storage keys</li>
            </ul>
            <div className="dialog-actions-row mt-8">
              <button
                className="btn"
                onClick={() => setShowResetConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="btn danger bold"
                onClick={handleResetApplication}
              >
                Delete all &amp; reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phase 7: Pairwise Seam Debugger Modal */}
      {activeSeamInspection && (
        <div className="modal-backdrop" onClick={() => setActiveSeamInspection(null)}>
          <div
            className="piece-preview-dialog seam-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="piece-preview-header">
              <div className="flex-row gap-12">
                <span className="fs-15 bold">
                  Pairwise seam debugger: Piece #{activeSeamInspection.pieceA.piece_number} ↔ Piece #{activeSeamInspection.pieceB.piece_number}
                </span>
                <div className="flex-row gap-6">
                  <span className="fs-11">Metric Tol:</span>
                  <input
                    type="range"
                    min="0.5"
                    max="4.0"
                    step="0.1"
                    value={activeSeamInspection.toleranceMm}
                    onChange={(e) => {
                      const newTol = parseFloat(e.target.value)
                      handleInspectPiecePair(activeSeamInspection.pieceA, activeSeamInspection.pieceB, newTol)
                    }}
                    className="w-80"
                  />
                  <span className="badge">
                    ±{activeSeamInspection.toleranceMm.toFixed(1)}mm
                  </span>
                </div>
              </div>
              <button
                className="btn small"
                onClick={() => setActiveSeamInspection(null)}
              >
                Close
              </button>
            </div>

            {/* Side-by-side piece thumbnails & seam selector */}
            <div className="seam-dialog-body">
              {/* Filtered Candidate Seams (Only Polarity-Compatible Tab ↔ Hole) */}
              <div>
                <div className="seam-selector-header">
                  <span>Valid candidate seams (Tab ↔ Hole only):</span>
                  <span>
                    Selected: Seam #{activeSeamInspection.selectedSeamIndex + 1}
                  </span>
                </div>
                {(() => {
                  const candidateSeams = activeSeamInspection.details.seams
                    .map((s: any, origIdx: number) => ({ ...s, origIdx }))
                    .filter((s: any) => s.polarity_compatible)
                    .sort((a: any, b: any) => {
                      if (a.is_mate !== b.is_mate) return a.is_mate ? -1 : 1
                      return a.l2_curve_distance - b.l2_curve_distance
                    })

                  if (candidateSeams.length === 0) {
                    return (
                      <div className="seam-empty-banner">
                        No Tab ↔ Hole pairings exist between these pieces (e.g. flat borders only).
                      </div>
                    )
                  }

                  return (
                    <div className="seam-btn-grid" style={{ gridTemplateColumns: `repeat(${Math.min(4, candidateSeams.length)}, 1fr)` }}>
                      {candidateSeams.map((s: any) => {
                        const isSelected = activeSeamInspection.selectedSeamIndex === s.origIdx
                        const isMate = s.is_mate

                        return (
                          <button
                            key={s.origIdx}
                            onClick={() => setActiveSeamInspection((prev) => prev ? { ...prev, selectedSeamIndex: s.origIdx } : null)}
                            className={`btn seam-candidate-btn ${isSelected ? 'selected' : ''}`}
                          >
                            <div>
                              <div>Piece #{activeSeamInspection.pieceA.piece_number} [E{s.edge_a_idx + 1}] ↔ Piece #{activeSeamInspection.pieceB.piece_number} [E{s.edge_b_idx + 1}]</div>
                              <div className="fs-12 mt-2">
                                {s.edge_a_type} ↔ {s.edge_b_type} | Δchord: {s.chord_diff_mm.toFixed(1)}mm
                              </div>
                            </div>
                            <span className={isMate ? 'green bold' : 'bold'}>
                              L2: {s.l2_curve_distance.toFixed(3)}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>

              {/* Active Selected Seam Deep-Dive Card */}
              {(() => {
                const s = activeSeamInspection.details.seams[activeSeamInspection.selectedSeamIndex]
                if (!s) return null
                const edgeA = activeSeamInspection.pieceA.edges[s.edge_a_idx]
                const edgeB = activeSeamInspection.pieceB.edges[s.edge_b_idx]

                const rotDegA = ((1 - s.edge_a_idx + 4) % 4) * 90
                const rotDegB = ((3 - s.edge_b_idx + 4) % 4) * 90

                const profA = getOrComputeNormalizedProfile(edgeA)
                const profB = getOrComputeNormalizedProfile(edgeB)
                const seamSamplesA = edgeA.seam_rgb_samples || []
                const seamSamplesB = edgeB.seam_rgb_samples || []

                // Point-by-point residual curve
                const residuals: number[] = []
                for (let k = 0; k < 100; k++) {
                  const valA = profA[k] || 0
                  const revB = profB[99 - k] || 0
                  residuals.push(valA + revB) // 0 if perfect complementary tab+hole
                }

                return (
                  <div className="seam-card">
                    <div className="seam-card-header">
                      <div className="flex-row gap-10">
                        <span className="fs-14 bold">
                          Physical seam inspection: Piece #{activeSeamInspection.pieceA.piece_number} [Edge {s.edge_a_idx + 1}: {s.edge_a_type}] ◄══► Piece #{activeSeamInspection.pieceB.piece_number} [Edge {s.edge_b_idx + 1}: {s.edge_b_type}]
                        </span>
                        <span className={`badge bold ${s.is_mate ? 'green' : 'red'}`}>
                          {s.is_mate ? 'Genuine mate (passed all gates)' : 'Rejected pairing'}
                        </span>
                      </div>
                    </div>

                    {/* Side-by-Side Physically Oriented Alignment Preview */}
                    <div className="seam-align-preview">
                      {/* Piece A Rotated so Edge A faces East (Right) */}
                      <div className="panel-col gap-6">
                        <div className="fs-11 bold">
                          Piece #{activeSeamInspection.pieceA.piece_number} (Edge {s.edge_a_idx + 1} facing Seam ➔)
                        </div>
                        <div className="seam-piece-thumb-wrap">
                          <img
                            src={activeSeamInspection.pieceA.thumbnailDataUrl}
                            alt={`Piece #${activeSeamInspection.pieceA.piece_number}`}
                            className="seam-piece-thumb"
                            style={{
                              transform: `rotate(${rotDegA}deg)`,
                            }}
                          />
                          {/* Indicator label on mating edge */}
                          <div className="seam-edge-badge-a">
                            E{s.edge_a_idx + 1}
                          </div>
                        </div>
                        <div className="fs-10">
                          Chord: {s.chord_len_a_mm.toFixed(1)}mm | Depth: {s.tab_depth_a_mm.toFixed(1)}mm
                        </div>
                      </div>

                      {/* Seam Cut Line Divider */}
                      <div className="seam-divider-wrap">
                        <div className={`seam-divider-line ${s.is_mate ? 'ok' : 'err'}`} />
                        <span className={`fs-10 bold ${s.is_mate ? 'green' : 'red'}`}>
                          {s.is_mate ? 'Seam fit' : 'Mismatch'}
                        </span>
                        <div className={`seam-divider-line ${s.is_mate ? 'ok' : 'err'}`} />
                      </div>

                      {/* Piece B Rotated so Edge B faces West (Left) */}
                      <div className="panel-col gap-6">
                        <div className="fs-11 bold">
                          ( Edge {s.edge_b_idx + 1} facing Seam) Piece #{activeSeamInspection.pieceB.piece_number}
                        </div>
                        <div className="seam-piece-thumb-wrap">
                          <img
                            src={activeSeamInspection.pieceB.thumbnailDataUrl}
                            alt={`Piece #${activeSeamInspection.pieceB.piece_number}`}
                            className="seam-piece-thumb"
                            style={{
                              transform: `rotate(${rotDegB}deg)`,
                            }}
                          />
                          {/* Indicator label on mating edge */}
                          <div className="seam-edge-badge-b">
                            E{s.edge_b_idx + 1}
                          </div>
                        </div>
                        <div className="fs-10">
                          Chord: {s.chord_len_b_mm.toFixed(1)}mm | Depth: {s.tab_depth_b_mm.toFixed(1)}mm
                        </div>
                      </div>
                    </div>

                    {/* Diagnostic Metric Grid */}
                    <div className="seam-metrics-grid">
                      {/* Step 1: Topology */}
                      <div className="stat-cell">
                        <div className="label-text">Step 1: Polarity</div>
                        <div className={`val-text ${s.polarity_compatible ? 'green' : 'red'}`}>
                          {s.polarity_compatible ? 'Compatible' : 'Incompatible'}
                        </div>
                        <div className="val-subtext mt-2">
                          {s.edge_a_type} ↔ {s.edge_b_type}
                        </div>
                      </div>

                      {/* Step 2: Millimeter Metric Chord & Tab Depth */}
                      <div className="stat-cell">
                        <div className="label-text">Step 2: Metric tolerance</div>
                        <div className={`val-text ${s.metric_pass ? 'green' : 'red'}`}>
                          {s.metric_pass ? `Passed (≤${activeSeamInspection.toleranceMm.toFixed(1)}mm)` : `Exceeded (>${activeSeamInspection.toleranceMm.toFixed(1)}mm)`}
                        </div>
                        <div className="val-subtext mt-2">
                          Δchord: {s.chord_diff_mm.toFixed(2)}mm | Δdepth: {s.tab_depth_diff_mm.toFixed(2)}mm
                        </div>
                      </div>

                      {/* Step 4: Sub-pixel Contour L2 Residual */}
                      <div className="stat-cell">
                        <div className="label-text">Step 4: Contour L2 / L∞</div>
                        <div className={`val-text ${s.l2_curve_distance <= 0.045 ? 'green' : s.l2_curve_distance <= 0.070 ? 'yellow' : 'red'}`}>
                          L2: {s.l2_curve_distance.toFixed(4)}
                        </div>
                        <div className="val-subtext mt-2">
                          L∞: {s.linf_curve_distance ? s.linf_curve_distance.toFixed(3) : 'N/A'} | Shift: {s.alignment_shift}px
                        </div>
                      </div>

                      {/* Step 3: Ink MGC Cost */}
                      <div className="stat-cell">
                        <div className="label-text">Step 3: Seam ink MGC</div>
                        <div className={`val-text ${s.ink_continuity_cost < 0 ? '' : s.ink_continuity_cost <= 0.30 ? 'green' : 'red'}`}>
                          {s.ink_continuity_cost < 0 ? 'N/A (No Ink)' : `Cost: ${s.ink_continuity_cost.toFixed(3)}`}
                        </div>
                        <div className="val-subtext mt-2">
                          Score: {(s.combined_score * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>

                    {/* Detailed Rejection Reason or Success Banner */}
                    <div className={`seam-status-banner ${s.is_mate ? 'ok' : 'err'}`}>
                      <b>Status:</b> {s.is_mate ? 'Passes all 4 physical gates: Complementary polarity, metric millimeter bounds, and complementary contour matching curve.' : s.rejection_reason || 'Failed physical verification gates.'}
                    </div>

                    {/* Seam Ink Continuity Strip (Gallagher MGC Color Preview) */}
                    {seamSamplesA.length > 0 && seamSamplesB.length > 0 && (
                      <div className="seam-ink-strip-container">
                        <div className="fs-10 bold mb-6 space-between">
                          <span>Seam ink continuity strip (Edge A Pixels ◄══► Reversed Edge B Pixels):</span>
                          <span className={s.ink_continuity_cost < 0.25 ? 'green' : 'yellow'}>
                            MGC Cost: {s.ink_continuity_cost.toFixed(3)}
                          </span>
                        </div>
                        {/* 100-pixel color strips meeting at seam */}
                        <div className="seam-ink-strips">
                          {/* Strip A */}
                          <div className="seam-ink-row">
                            {seamSamplesA.map((rgb, idx) => (
                              <div key={idx} className="flex-1" style={{ background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }} />
                            ))}
                          </div>
                          {/* Strip B (Traversed in reverse along common seam) */}
                          <div className="seam-ink-row">
                            {seamSamplesA.map((_, idx) => {
                              const revIdx = seamSamplesB.length - 1 - idx
                              const rgb = seamSamplesB[revIdx] || [0, 0, 0]
                              return <div key={idx} className="flex-1" style={{ background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }} />
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Point-by-Point Curve Superposition & Residual Error Heatmap */}
                    <div className="seam-curve-box">
                      <div className="fs-10 bold mb-8 space-between">
                        <span>Complementary curve overlay & residual gap:</span>
                        <div className="flex-row gap-12">
                          <span>― Piece #{activeSeamInspection.pieceA.piece_number} [E{s.edge_a_idx + 1}]</span>
                          <span>― Piece #{activeSeamInspection.pieceB.piece_number} [E{s.edge_b_idx + 1}] (Reversed)</span>
                          <span className="red">― Residual Error</span>
                        </div>
                      </div>
                      <svg width="100%" height="100" viewBox="0 0 600 100">
                        {/* Baseline Chord */}
                        <line x1="20" y1="50" x2="580" y2="50" stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
                        {/* Residual error shaded bars */}
                        {residuals.map((res, i) => {
                          const x = 20 + (i / 99) * 560
                          const barH = Math.min(40, Math.abs(res) * 200)
                          const isHigh = Math.abs(res) > 0.065
                          return (
                            <line
                              key={i}
                              x1={x}
                              y1={50 - barH / 2}
                              x2={x}
                              y2={50 + barH / 2}
                              stroke={isHigh ? 'var(--err)' : 'var(--ok)'}
                              strokeWidth="2"
                            />
                          )
                        })}
                        {/* Profile A */}
                        {(() => {
                          const ptsA = profA.map((v, i) => `${20 + (i / 99) * 560},${50 - v * 200}`).join(' ')
                          return <polyline points={ptsA} fill="none" stroke="var(--fg)" strokeWidth="2" />
                        })()}
                        {/* Profile B Reversed and Inverted Complement */}
                        {(() => {
                          const ptsB = profB.map((_, i) => {
                            const revIdx = 99 - i
                            const valB = profB[revIdx] || 0
                            return `${20 + (i / 99) * 560},${50 + valB * 200}`
                          }).join(' ')
                          return <polyline points={ptsB} fill="none" stroke="var(--fg)" strokeWidth="1.5" strokeDasharray="2 2" />
                        })()}
                      </svg>
                    </div>
                  </div>
                )
              })()}

              {/* Footer Actions: Ground-Truth Fixture Recording */}
              <div className="seam-footer-row">
                <div className={`fs-11 ${activeSeamInspection.saveStatus?.startsWith('Saved') ? 'green' : ''}`}>
                  {activeSeamInspection.saveStatus || 'Export verification fixture to datasets/ground_truth/pairs/ for automated test gating.'}
                </div>
                <div className="flex-row gap-8">
                  <button
                    className="btn danger"
                    onClick={() => handleSavePairFixture(false)}
                    title="Save as True Negative ground truth fixture (these pieces do NOT match)"
                  >
                    Save as non-mate (False)
                  </button>
                  <button
                    className="btn primary bold"
                    onClick={() => handleSavePairFixture(true)}
                    title="Save as True Positive ground truth fixture (these pieces physically match on cardboard)"
                  >
                    Save as confirmed mate (True)
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
