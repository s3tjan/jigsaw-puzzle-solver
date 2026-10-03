import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { StoredPiece, PlacedBoardSlot, GroundTruthPairFixture } from '../storage/db'
import { get_slot_preview } from '../pkg/cv_engine'
import './BoardView.css'

export interface SlotRequirementFilter {
  row: number
  col: number
  is_border: boolean
  is_corner: boolean
  required_edges: [
    ('Flat' | 'Tab' | 'Hole') | null,
    ('Flat' | 'Tab' | 'Hole') | null,
    ('Flat' | 'Tab' | 'Hole') | null,
    ('Flat' | 'Tab' | 'Hole') | null,
  ]
}

export function suggestGridForPieceCount(targetPieces: number, targetAspect = 1.4): { cols: number; rows: number; total: number } {
  if (targetPieces <= 4) return { cols: 2, rows: 2, total: 4 }

  let bestCols = Math.round(Math.sqrt(targetPieces * targetAspect))
  let bestRows = Math.round(targetPieces / (bestCols || 1))
  let bestDiff = Math.abs(bestCols * bestRows - targetPieces)
  let bestAspectDiff = Math.abs((bestCols / (bestRows || 1)) - targetAspect)

  const maxR = Math.max(10, Math.floor(Math.sqrt(targetPieces * 2)))
  for (let r = 2; r <= maxR; r++) {
    const c = Math.round(targetPieces / r)
    const total = c * r
    const diff = Math.abs(total - targetPieces)
    const aspectDiff = Math.abs((c / (r || 1)) - targetAspect)

    if (diff < bestDiff || (diff === bestDiff && aspectDiff < bestAspectDiff)) {
      bestCols = c
      bestRows = r
      bestDiff = diff
      bestAspectDiff = aspectDiff
    }
  }

  if (targetAspect >= 1.0 && bestCols < bestRows) {
    const tmp = bestCols
    bestCols = bestRows
    bestRows = tmp
  }

  return { cols: bestCols, rows: bestRows, total: bestCols * bestRows }
}

interface BoardViewProps {
  rows: number
  cols: number
  pieces: StoredPiece[]
  placedSlots: Record<string, PlacedBoardSlot>
  pairedFixtures?: GroundTruthPairFixture[]
  onPlacePiece: (row: number, col: number, pieceId: string, rotation: number) => void
  onUnplacePiece: (row: number, col: number) => void
  selectedSlot: { row: number; col: number } | null
  onSelectSlot: (slot: { row: number; col: number } | null) => void
  onUpdatePairStatus?: (pairId: string, status: 'verified' | 'rejected') => void
  posterRgba: Uint8Array | null
  posterWidth: number
  posterHeight: number
  posterFileName?: string
  physWidthMm?: number
  physHeightMm?: number
  onExportFixtures: () => void
  onImportFixtures: () => void
  onPosterIngested?: (img: HTMLImageElement, file: File) => void
  onUpdateDimensions?: (cols: number, rows: number, physWidthMm: number, physHeightMm: number) => void
  highlightedSlot?: { row: number; col: number } | null
  onSolvePerimeter?: () => void
  onApplyPerimeter?: () => void
  solvedPerimeterCount?: number
  totalPerimeterCount?: number
  candidateMatches?: CandidateMatchOverlay[]
  onDeletePiece?: (pieceId: string) => void
  onResetApplication?: () => void
  onSelectPiecePreview?: (piece: StoredPiece) => void
  onSlotClick?: (row: number, col: number) => void
  onRotatePerimeter?: () => void
  onRotatePoster?: (deg: 90 | 180) => void
}

export interface CandidateMatchOverlay {
  row: number
  col: number
  rotation_deg: number
  confidence: number
  rank: number
}

export const BoardView: React.FC<BoardViewProps> = ({
  rows,
  cols,
  pieces,
  placedSlots,
  pairedFixtures = [],
  onPlacePiece,
  onUnplacePiece,
  selectedSlot,
  onSelectSlot,
  onUpdatePairStatus,
  posterRgba,
  posterWidth,
  posterHeight,
  posterFileName = '',
  physWidthMm = 700,
  physHeightMm = 500,
  onExportFixtures,
  onImportFixtures,
  onPosterIngested,
  onUpdateDimensions,
  highlightedSlot = null,
  onSolvePerimeter,
  onApplyPerimeter,
  solvedPerimeterCount = 0,
  totalPerimeterCount = 0,
  candidateMatches = [],
  onDeletePiece,
  onResetApplication,
  onSelectPiecePreview,
  onSlotClick,
  onRotatePerimeter,
  onRotatePoster,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const cropCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pan and Zoom transform state
  const [zoom, setZoom] = useState<number>(1.0)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 40, y: 40 })
  const isDraggingRef = useRef<boolean>(false)
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const [hoverSlot, setHoverSlot] = useState<{ r: number; c: number } | null>(null)
  const [posterOpacity, setPosterOpacity] = useState<number>(0.35)
  const [showPosterUnderlay, setShowPosterUnderlay] = useState<boolean>(true)
  const [showCoordinates, setShowCoordinates] = useState<boolean>(false)
  const [isDragOver, setIsDragOver] = useState<boolean>(false)
  const posterCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // Puzzle specification configuration states
  const [inputCols, setInputCols] = useState<number>(cols)
  const [inputRows, setInputRows] = useState<number>(rows)
  const [inputTotalPieces, setInputTotalPieces] = useState<number>(cols * rows)
  const [inputWidthMm, setInputWidthMm] = useState<number>(physWidthMm)
  const [inputHeightMm, setInputHeightMm] = useState<number>(physHeightMm)
  const [appliedFeedback, setAppliedFeedback] = useState<boolean>(false)

  // Synchronize when external props update
  useEffect(() => {
    setInputCols(cols)
    setInputRows(rows)
    setInputTotalPieces(cols * rows)
  }, [cols, rows])

  useEffect(() => {
    setInputWidthMm(physWidthMm)
    setInputHeightMm(physHeightMm)
  }, [physWidthMm, physHeightMm])

  const handleTotalPiecesChange = (valStr: string) => {
    const val = parseInt(valStr) || 0
    setInputTotalPieces(val)
    if (val >= 4) {
      const aspect = (inputWidthMm > 0 && inputHeightMm > 0) ? (inputWidthMm / inputHeightMm) : 1.4
      const suggested = suggestGridForPieceCount(val, aspect)
      setInputCols(suggested.cols)
      setInputRows(suggested.rows)
    }
  }

  const handleColsChange = (valStr: string) => {
    const newCols = parseInt(valStr) || 0
    setInputCols(newCols)
    if (newCols > 0 && inputRows > 0) {
      setInputTotalPieces(newCols * inputRows)
    }
  }

  const handleRowsChange = (valStr: string) => {
    const newRows = parseInt(valStr) || 0
    setInputRows(newRows)
    if (newRows > 0 && inputCols > 0) {
      setInputTotalPieces(inputCols * newRows)
    }
  }

  const handleApplyDimensions = () => {
    const c = Math.max(1, inputCols)
    const r = Math.max(1, inputRows)
    const w = Math.max(10, inputWidthMm)
    const h = Math.max(10, inputHeightMm)
    setInputCols(c)
    setInputRows(r)
    setInputTotalPieces(c * r)
    if (onUpdateDimensions) {
      onUpdateDimensions(c, r, w, h)
      setAppliedFeedback(true)
      setTimeout(() => setAppliedFeedback(false), 1500)
    }
  }

  const handleKeyDownSpec = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleApplyDimensions()
    }
  }

  // Map piece_id -> StoredPiece for instant lookup
  const pieceMap = useMemo(() => {
    const map = new Map<string, StoredPiece>()
    for (const p of pieces) {
      map.set(p.id, p)
    }
    return map
  }, [pieces])

  // Convert posterRgba to an offscreen canvas for fast drawing onto board canvas
  useEffect(() => {
    if (!posterRgba || posterWidth <= 0 || posterHeight <= 0) {
      posterCanvasRef.current = null
      return
    }
    const off = document.createElement('canvas')
    off.width = posterWidth
    off.height = posterHeight
    const ctx = off.getContext('2d')
    if (ctx) {
      const imgData = ctx.createImageData(posterWidth, posterHeight)
      imgData.data.set(posterRgba)
      ctx.putImageData(imgData, 0, 0)
      posterCanvasRef.current = off
      drawBoard()
    }
  }, [posterRgba, posterWidth, posterHeight])

  // Cache loaded Image objects for placed piece thumbnails to draw onto grid canvas
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())

  useEffect(() => {
    for (const slot of Object.values(placedSlots)) {
      const piece = pieceMap.get(slot.piece_id)
      if (piece && !imageCacheRef.current.has(piece.id)) {
        const img = new Image()
        img.src = piece.thumbnailDataUrl
        img.onload = () => {
          // Trigger redraw
          drawBoard()
        }
        imageCacheRef.current.set(piece.id, img)
      }
    }
  }, [placedSlots, pieceMap])

  // Derive neighbor edge constraints for a given slot [r, c]
  const computeSlotRequirement = useCallback((r: number, c: number): SlotRequirementFilter => {
    const is_corner =
      (r === 0 && c === 0) ||
      (r === 0 && c === cols - 1) ||
      (r === rows - 1 && c === 0) ||
      (r === rows - 1 && c === cols - 1)

    const is_border = r === 0 || r === rows - 1 || c === 0 || c === cols - 1

    // Directions: 0: North, 1: East, 2: South, 3: West
    const reqs: [
      ('Flat' | 'Tab' | 'Hole') | null,
      ('Flat' | 'Tab' | 'Hole') | null,
      ('Flat' | 'Tab' | 'Hole') | null,
      ('Flat' | 'Tab' | 'Hole') | null,
    ] = [null, null, null, null]

    // 1. Fixed border edges must be Flat
    if (r === 0) reqs[0] = 'Flat'
    if (c === cols - 1) reqs[1] = 'Flat'
    if (r === rows - 1) reqs[2] = 'Flat'
    if (c === 0) reqs[3] = 'Flat'

    // 2. Neighbor placed pieces impose complementary mating edges
    // North neighbor placed? Its South edge (side 2 of neighbor) meets our North (side 0)
    const northSlot = placedSlots[`${r - 1},${c}`]
    if (northSlot) {
      const np = pieceMap.get(northSlot.piece_id)
      if (np) {
        // under neighbor's rotation, which edge points South (side 2)?
        // side 2 of cell comes from piece edge (2 - rot + 4) % 4
        const edgeIdx = (2 - northSlot.rotation + 4) % 4
        const neighborEdgeType = np.edges[edgeIdx].edge_type
        if (neighborEdgeType === 'Tab') reqs[0] = 'Hole'
        else if (neighborEdgeType === 'Hole') reqs[0] = 'Tab'
      }
    }

    // East neighbor placed? Its West edge (side 3) meets our East (side 1)
    const eastSlot = placedSlots[`${r},${c + 1}`]
    if (eastSlot) {
      const ep = pieceMap.get(eastSlot.piece_id)
      if (ep) {
        const edgeIdx = (3 - eastSlot.rotation + 4) % 4
        const neighborEdgeType = ep.edges[edgeIdx].edge_type
        if (neighborEdgeType === 'Tab') reqs[1] = 'Hole'
        else if (neighborEdgeType === 'Hole') reqs[1] = 'Tab'
      }
    }

    // South neighbor placed? Its North edge (side 0) meets our South (side 2)
    const southSlot = placedSlots[`${r + 1},${c}`]
    if (southSlot) {
      const sp = pieceMap.get(southSlot.piece_id)
      if (sp) {
        const edgeIdx = (0 - southSlot.rotation + 4) % 4
        const neighborEdgeType = sp.edges[edgeIdx].edge_type
        if (neighborEdgeType === 'Tab') reqs[2] = 'Hole'
        else if (neighborEdgeType === 'Hole') reqs[2] = 'Tab'
      }
    }

    // West neighbor placed? Its East edge (side 1) meets our West (side 3)
    const westSlot = placedSlots[`${r},${c - 1}`]
    if (westSlot) {
      const wp = pieceMap.get(westSlot.piece_id)
      if (wp) {
        const edgeIdx = (1 - westSlot.rotation + 4) % 4
        const neighborEdgeType = wp.edges[edgeIdx].edge_type
        if (neighborEdgeType === 'Tab') reqs[3] = 'Hole'
        else if (neighborEdgeType === 'Hole') reqs[3] = 'Tab'
      }
    }

    return {
      row: r,
      col: c,
      is_border,
      is_corner,
      required_edges: reqs,
    }
  }, [rows, cols, placedSlots, pieceMap])


  // Extract slot preview from WASM poster when slot is selected
  const activeSlotPreview = useMemo(() => {
    if (!selectedSlot || !posterRgba || posterWidth === 0 || posterHeight === 0) return null
    try {
      const preview = get_slot_preview(
        posterRgba,
        posterWidth,
        posterHeight,
        cols,
        rows,
        selectedSlot.col,
        selectedSlot.row
      )
      return preview
    } catch {
      return null
    }
  }, [selectedSlot, posterRgba, posterWidth, posterHeight, cols, rows])

  // Render slot preview crop onto inspector thumbnail canvas
  useEffect(() => {
    if (!cropCanvasRef.current || !activeSlotPreview) return
    const canvas = cropCanvasRef.current
    canvas.width = activeSlotPreview.width
    canvas.height = activeSlotPreview.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const imgData = ctx.createImageData(activeSlotPreview.width, activeSlotPreview.height)
    imgData.data.set(activeSlotPreview.rgba_crop)
    ctx.putImageData(imgData, 0, 0)
  }, [activeSlotPreview])

  // Draw board onto 2D canvas
  const drawBoard = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)

    ctx.save()
    ctx.translate(pan.x, pan.y)
    ctx.scale(zoom, zoom)

    const cellW = 32
    const cellH = 32
    const boardTotalW = cols * cellW
    const boardTotalH = rows * cellH

    // Board background mat
    ctx.fillStyle = '#11161d'
    ctx.fillRect(0, 0, boardTotalW, boardTotalH)

    // Render reference poster underlay if available and enabled
    if (showPosterUnderlay && posterCanvasRef.current) {
      ctx.save()
      ctx.globalAlpha = posterOpacity
      ctx.drawImage(posterCanvasRef.current, 0, 0, boardTotalW, boardTotalH)
      ctx.restore()
    }

    // Render cells
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cellW
        const y = r * cellH
        const slotKey = `${r},${c}`
        const placed = placedSlots[slotKey]
        const isSelected = selectedSlot && selectedSlot.row === r && selectedSlot.col === c
        const isHovered = hoverSlot && hoverSlot.r === r && hoverSlot.c === c
        const is_corner =
          (r === 0 && c === 0) ||
          (r === 0 && c === cols - 1) ||
          (r === rows - 1 && c === 0) ||
          (r === rows - 1 && c === cols - 1)
        const is_border = r === 0 || r === rows - 1 || c === 0 || c === cols - 1

        // Base cell fill
        if (placed) {
          ctx.fillStyle = '#1c2530'
        } else if (isSelected) {
          ctx.fillStyle = 'rgba(255, 211, 61, 0.35)'
        } else if (isHovered) {
          ctx.fillStyle = 'rgba(88, 166, 255, 0.2)'
        } else if (is_corner) {
          ctx.fillStyle = 'rgba(248, 81, 73, 0.08)'
        } else if (is_border) {
          ctx.fillStyle = 'rgba(210, 153, 34, 0.05)'
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
        }
        ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2)

        // Draw placed piece thumbnail if loaded
        if (placed) {
          const img = imageCacheRef.current.get(placed.piece_id)
          if (img && img.complete) {
            ctx.save()
            ctx.translate(x + cellW / 2, y + cellH / 2)
            ctx.rotate((placed.rotation * 90 * Math.PI) / 180)
            ctx.drawImage(img, -cellW / 2 + 1, -cellH / 2 + 1, cellW - 2, cellH - 2)
            ctx.restore()
          }

          // Subtle placed green corner dot
          ctx.fillStyle = '#3fb950'
          ctx.beginPath()
          ctx.arc(x + 4, y + 4, 2, 0, Math.PI * 2)
          ctx.fill()
        }

        const cand = candidateMatches?.find((cnd) => cnd.row === r && cnd.col === c)
        const isHighlighted = (highlightedSlot && highlightedSlot.row === r && highlightedSlot.col === c) || (cand && cand.rank === 1)

        // Candidate cell fill & outline
        if (cand && !placed) {
          if (cand.rank === 1) {
            ctx.fillStyle = 'rgba(0, 255, 180, 0.35)'
            ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2)
            ctx.strokeStyle = '#00ffb4'
            ctx.lineWidth = 3 / zoom
            ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2)
          } else {
            ctx.fillStyle = 'rgba(230, 180, 30, 0.20)'
            ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2)
            ctx.strokeStyle = '#e3b341'
            ctx.lineWidth = 2 / zoom
            ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2)
          }
        } else {
          // Cell border outline
          ctx.strokeStyle = isHighlighted
            ? '#00ff88'
            : isSelected
              ? '#ffd33d'
              : isHovered
                ? '#58a6ff'
                : is_corner
                  ? 'rgba(248, 81, 73, 0.35)'
                  : is_border
                    ? 'rgba(210, 153, 34, 0.25)'
                    : 'rgba(255, 255, 255, 0.07)'
          ctx.lineWidth = isHighlighted ? 3 / zoom : isSelected ? 2 / zoom : isHovered ? 1.5 / zoom : 0.75 / zoom
          ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2)

          if (isHighlighted) {
            ctx.fillStyle = 'rgba(0, 255, 136, 0.25)'
            ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2)
          }
        }

        // Candidate Badge Overlay on cell
        if (cand && !placed && cellW * zoom > 22) {
          ctx.save()
          ctx.font = `bold ${Math.max(8, Math.min(11, 8.5 * zoom))}px sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          const label = cand.rank === 1 ? `#1 ${Math.round(cand.confidence)}%` : `#${cand.rank} ${Math.round(cand.confidence)}%`
          const tw = ctx.measureText(label).width + 6
          const th = 14
          ctx.fillStyle = cand.rank === 1 ? 'rgba(0, 40, 25, 0.90)' : 'rgba(40, 30, 10, 0.90)'
          ctx.fillRect(x + cellW / 2 - tw / 2, y + cellH / 2 - th / 2, tw, th)
          ctx.strokeStyle = cand.rank === 1 ? '#00ffb4' : '#e3b341'
          ctx.lineWidth = 1
          ctx.strokeRect(x + cellW / 2 - tw / 2, y + cellH / 2 - th / 2, tw, th)
          ctx.fillStyle = cand.rank === 1 ? '#00ffb4' : '#ffd33d'
          ctx.fillText(label, x + cellW / 2, y + cellH / 2)
          ctx.restore()
        }

        // Piece number label or slot coordinates on cell
        if (placed) {
          const piece = pieceMap.get(placed.piece_id)
          if (piece && cellW * zoom > 20) {
            ctx.fillStyle = '#ffffff'
            ctx.font = `bold ${Math.max(8, Math.min(11, 9 * zoom))}px monospace`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(`#${piece.piece_number}`, x + cellW / 2, y + cellH / 2)
          }
        } else if ((showCoordinates || isHovered || isSelected) && cellW * zoom > 18) {
          const fontSize = Math.max(7, Math.min(10, 8 * zoom))
          ctx.font = `bold ${fontSize}px monospace`
          ctx.fillStyle = isSelected ? '#ffd33d' : isHovered ? '#00e5ff' : 'rgba(255, 255, 255, 0.45)'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(`[${c},${r}]`, x + cellW / 2, y + cellH / 2)
        }
      }
    }

    // Render Mating Pair Seam Indicators between placed neighbors
    const fixtureLookup = new Map<string, GroundTruthPairFixture>()
    for (const fix of pairedFixtures) {
      fixtureLookup.set([fix.piece_a_id, fix.piece_b_id].sort().join(':'), fix)
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const slotA = placedSlots[`${r},${c}`]
        if (!slotA) continue

        // East seam
        if (c + 1 < cols) {
          const slotB = placedSlots[`${r},${c + 1}`]
          if (slotB) {
            const pairKey = [slotA.piece_id, slotB.piece_id].sort().join(':')
            const fix = fixtureLookup.get(pairKey)
            const seamX = (c + 1) * cellW
            const seamY1 = r * cellH + 3
            const seamY2 = (r + 1) * cellH - 3

            ctx.lineWidth = 3 / zoom
            if (fix?.status === 'verified') {
              ctx.strokeStyle = '#3fb950' // Green
              ctx.setLineDash([])
            } else if (fix?.status === 'rejected') {
              ctx.strokeStyle = '#f85149' // Red
              ctx.setLineDash([4 / zoom, 2 / zoom])
            } else {
              ctx.strokeStyle = '#d29922' // Yellow provisional
              ctx.setLineDash([2 / zoom, 2 / zoom])
            }
            ctx.beginPath()
            ctx.moveTo(seamX, seamY1)
            ctx.lineTo(seamX, seamY2)
            ctx.stroke()
            ctx.setLineDash([])
          }
        }

        // South seam
        if (r + 1 < rows) {
          const slotB = placedSlots[`${r + 1},${c}`]
          if (slotB) {
            const pairKey = [slotA.piece_id, slotB.piece_id].sort().join(':')
            const fix = fixtureLookup.get(pairKey)
            const seamY = (r + 1) * cellH
            const seamX1 = c * cellW + 3
            const seamX2 = (c + 1) * cellW - 3

            ctx.lineWidth = 3 / zoom
            if (fix?.status === 'verified') {
              ctx.strokeStyle = '#3fb950' // Green
              ctx.setLineDash([])
            } else if (fix?.status === 'rejected') {
              ctx.strokeStyle = '#f85149' // Red
              ctx.setLineDash([4 / zoom, 2 / zoom])
            } else {
              ctx.strokeStyle = '#d29922' // Yellow provisional
              ctx.setLineDash([2 / zoom, 2 / zoom])
            }
            ctx.beginPath()
            ctx.moveTo(seamX1, seamY)
            ctx.lineTo(seamX2, seamY)
            ctx.stroke()
            ctx.setLineDash([])
          }
        }
      }
    }

    // Outer puzzle frame
    ctx.strokeStyle = '#58a6ff'
    ctx.lineWidth = 2 / zoom
    ctx.strokeRect(0, 0, boardTotalW, boardTotalH)

    ctx.restore()
  }, [rows, cols, pan, zoom, placedSlots, selectedSlot, hoverSlot, pieceMap, pairedFixtures, showPosterUnderlay, posterOpacity, showCoordinates])

  useEffect(() => {
    drawBoard()
  }, [drawBoard])

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87
    setZoom((prev) => Math.min(4.0, Math.max(0.4, prev * zoomFactor)))
  }

  // Drag and pan handling
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0 || e.button === 1) {
      isDraggingRef.current = true
      lastMouseRef.current = { x: e.clientX, y: e.clientY }
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      const dx = e.clientX - lastMouseRef.current.x
      const dy = e.clientY - lastMouseRef.current.y
      lastMouseRef.current = { x: e.clientX, y: e.clientY }
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
    } else {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const mouseX = (e.clientX - rect.left - pan.x) / zoom
      const mouseY = (e.clientY - rect.top - pan.y) / zoom

      const cellW = 32
      const cellH = 32
      const c = Math.floor(mouseX / cellW)
      const r = Math.floor(mouseY / cellH)

      if (r >= 0 && r < rows && c >= 0 && c < cols) {
        setHoverSlot({ r, c })
      } else {
        setHoverSlot(null)
      }
    }
  }

  const handleMouseUp = () => {
    isDraggingRef.current = false
  }

  // Click slot to select and inspect (Mode C)
  const handleClick = (e: React.MouseEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mouseX = (e.clientX - rect.left - pan.x) / zoom
    const mouseY = (e.clientY - rect.top - pan.y) / zoom

    const cellW = 32
    const cellH = 32
    const c = Math.floor(mouseX / cellW)
    const r = Math.floor(mouseY / cellH)

    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      if (onSlotClick) {
        onSlotClick(r, c)
      } else if (selectedSlot && selectedSlot.row === r && selectedSlot.col === c) {
        onSelectSlot(null)
      } else {
        onSelectSlot({ row: r, col: c })
      }
    }
  }

  // Drag over handler for dropping pieces or master poster files
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
      e.dataTransfer.dropEffect = 'copy'
    } else {
      e.dataTransfer.dropEffect = 'move'
    }
  }

  const handleDragLeave = () => {
    setIsDragOver(false)
  }

  // Drop piece from inventory or image file onto board canvas
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    // 1. Check if an image file was dropped
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0]
      if (file.type.startsWith('image/')) {
        const img = new Image()
        img.src = URL.createObjectURL(file)
        img.onload = () => {
          if (onPosterIngested) {
            onPosterIngested(img, file)
          }
        }
        return
      }
    }

    // 2. Otherwise handle piece drop onto slot
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mouseX = (e.clientX - rect.left - pan.x) / zoom
    const mouseY = (e.clientY - rect.top - pan.y) / zoom

    const cellW = 32
    const cellH = 32
    const c = Math.floor(mouseX / cellW)
    const r = Math.floor(mouseY / cellH)

    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      try {
        const raw = e.dataTransfer.getData('application/json')
        if (raw) {
          const data = JSON.parse(raw)
          if (data.piece_id) {
            onPlacePiece(r, c, data.piece_id, 0)
            onSelectSlot({ row: r, col: c })
          }
        }
      } catch (err) {
        console.error('Failed to parse dropped piece:', err)
      }
    }
  }

  // Resize canvas to container
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current && canvasRef.current) {
        canvasRef.current.width = containerRef.current.clientWidth
        canvasRef.current.height = containerRef.current.clientHeight
        drawBoard()
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [drawBoard])

  const placedCount = Object.keys(placedSlots).length
  const totalSlots = rows * cols
  const progressPct = ((placedCount / totalSlots) * 100).toFixed(1)

  const selectedSlotPlaced = selectedSlot ? placedSlots[`${selectedSlot.row},${selectedSlot.col}`] : null
  const selectedSlotPiece = selectedSlotPlaced ? pieceMap.get(selectedSlotPlaced.piece_id) : null
  const selectedSlotReq = selectedSlot ? computeSlotRequirement(selectedSlot.row, selectedSlot.col) : null

  return (
    <div className="board-view-container">
      {/* Top Header Bar */}
      <div className="board-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="stat-badge placed">PLACED: {placedCount} / {totalSlots} ({progressPct}%)</span>
          <span className="stat-badge unplaced">REMAINING: {totalSlots - placedCount}</span>
          {posterFileName && <span className="stat-badge unplaced">{posterFileName}</span>}
          {posterWidth > 0 && (
            <span className="stat-badge unplaced">
              {posterWidth} × {posterHeight} px
            </span>
          )}
        </div>

        <div className="board-header-actions">
          {onSolvePerimeter && (
            <button
              className="board-btn primary highlight"
              style={{ background: '#238636', borderColor: '#2ea043', color: '#fff', fontWeight: 'bold' }}
              onClick={onSolvePerimeter}
              title="Solve 1D closed border loop"
            >
              SOLVE PERIMETER {solvedPerimeterCount > 0 ? `(${solvedPerimeterCount} / ${totalPerimeterCount})` : ''}
            </button>
          )}
          {onApplyPerimeter && solvedPerimeterCount > 0 && (
            <button
              className="board-btn"
              style={{ background: '#1f6feb', borderColor: '#388bfd', color: '#fff', fontWeight: 'bold' }}
              onClick={onApplyPerimeter}
              title="Apply all solved perimeter pieces to the board"
            >
              APPLY PERIMETER ({solvedPerimeterCount})
            </button>
          )}
          {onRotatePerimeter && (
            <button
              className="board-btn"
              onClick={onRotatePerimeter}
              title="Rotate solved perimeter placements by 180 degrees"
            >
              ROTATE PERIMETER 180°
            </button>
          )}
          {onRotatePoster && posterWidth > 0 && (
            <>
              <button
                className="board-btn"
                onClick={() => onRotatePoster(90)}
                title="Rotate master poster 90 degrees clockwise"
              >
                ROTATE POSTER 90°
              </button>
              <button
                className="board-btn"
                onClick={() => onRotatePoster(180)}
                title="Rotate master poster 180 degrees"
              >
                ROTATE POSTER 180°
              </button>
            </>
          )}
          <button className="board-btn" onClick={onImportFixtures} title="Import saved assembly JSON dataset">
            IMPORT JSON
          </button>
          <button className="board-btn primary" onClick={onExportFixtures} title="Export ground-truth assembly fixtures">
            EXPORT FIXTURES
          </button>
        </div>
      </div>

      {/* Specification & Dimension Controls Bar */}
      <div className="board-spec-bar">
        <div className="spec-group">
          <label>PIECES:</label>
          <input
            type="number"
            className="spec-input"
            style={{ width: 64, fontWeight: 'bold', color: '#58a6ff', textAlign: 'center' }}
            value={inputTotalPieces || ''}
            min={4}
            max={10000}
            title="Total puzzle piece count (e.g. 1008, 1000, 1120). Press Enter to apply."
            onChange={(e) => handleTotalPiecesChange(e.target.value)}
            onKeyDown={handleKeyDownSpec}
            onBlur={handleApplyDimensions}
          />
        </div>

        <div className="spec-group">
          <label>GRID (COLS × ROWS):</label>
          <input
            type="number"
            className="spec-input"
            value={inputCols || ''}
            min={2}
            max={100}
            title="Columns. Press Enter to apply."
            onChange={(e) => handleColsChange(e.target.value)}
            onKeyDown={handleKeyDownSpec}
            onBlur={handleApplyDimensions}
          />
          <span className="spec-unit">×</span>
          <input
            type="number"
            className="spec-input"
            value={inputRows || ''}
            min={2}
            max={100}
            title="Rows. Press Enter to apply."
            onChange={(e) => handleRowsChange(e.target.value)}
            onKeyDown={handleKeyDownSpec}
            onBlur={handleApplyDimensions}
          />
        </div>

        <div className="spec-group">
          <label>PHYSICAL (W × H):</label>
          <input
            type="number"
            className="spec-input"
            value={inputWidthMm || ''}
            min={50}
            max={3000}
            title="Width in mm. Press Enter to apply."
            onChange={(e) => setInputWidthMm(parseFloat(e.target.value) || 0)}
            onKeyDown={handleKeyDownSpec}
            onBlur={handleApplyDimensions}
          />
          <span className="spec-unit">×</span>
          <input
            type="number"
            className="spec-input"
            value={inputHeightMm || ''}
            min={50}
            max={3000}
            title="Height in mm. Press Enter to apply."
            onChange={(e) => setInputHeightMm(parseFloat(e.target.value) || 0)}
            onKeyDown={handleKeyDownSpec}
            onBlur={handleApplyDimensions}
          />
          <span className="spec-unit">mm</span>
        </div>

        {(() => {
          const isDirty = inputCols !== cols || inputRows !== rows || inputWidthMm !== physWidthMm || inputHeightMm !== physHeightMm
          return (
            <button
              className="board-btn primary"
              style={{
                padding: '3px 10px',
                fontSize: 10,
                background: appliedFeedback ? '#238636' : (isDirty ? '#1f6feb' : '#21262d'),
                borderColor: appliedFeedback ? '#2ea043' : (isDirty ? '#388bfd' : '#30363d'),
                color: '#fff',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
              onClick={handleApplyDimensions}
              title="Apply grid and physical dimensions [Enter]"
            >
              {appliedFeedback ? 'APPLIED' : isDirty ? 'APPLY SPECS [ENTER]' : 'APPLY SPECS'}
            </button>
          )
        })()}

        <div className="spec-slot-info">
          SLOT: <b>{cols > 0 ? (physWidthMm / cols).toFixed(1) : 0} × {rows > 0 ? (physHeightMm / rows).toFixed(1) : 0} mm</b>
          <span style={{ marginLeft: 6, color: '#8b949e', fontSize: 10 }}>
            (Perimeter: 4 corners + {2 * Math.max(0, cols - 2) + 2 * Math.max(0, rows - 2)} borders = {2 * Math.max(0, cols - 2) + 2 * Math.max(0, rows - 2) + 4} total)
          </span>
        </div>

        {onResetApplication && (
          <button
            className="board-btn"
            style={{
              padding: '3px 10px',
              fontSize: 10,
              background: '#3a1d1d',
              borderColor: '#f85149',
              color: '#ff7b72',
              fontWeight: 'bold',
              cursor: 'pointer',
              marginLeft: 'auto',
            }}
            onClick={onResetApplication}
            title="Delete all scanned pieces and reset application to fresh state"
          >
            START FRESH
          </button>
        )}
      </div>

      {/* Main Board View: Interactive Canvas + Slot Inspector */}
      <div className="board-main-layout">
        {/* Canvas Pane */}
        <div className="board-canvas-pane" ref={containerRef}>
          <div className="board-canvas-toolbar">
            <button className="board-tool-btn" onClick={() => setZoom((z) => Math.min(4.0, z * 1.25))}>+</button>
            <button className="board-tool-btn" onClick={() => setZoom((z) => Math.max(0.4, z * 0.8))}>−</button>
            <button className="board-tool-btn" onClick={() => { setZoom(1.0); setPan({ x: 40, y: 40 }) }}>RESET</button>
            <button
              className={`board-tool-btn ${showCoordinates ? 'active' : ''}`}
              onClick={() => setShowCoordinates(!showCoordinates)}
              title="Toggle coordinate labels in slots"
            >
              COORDS: {showCoordinates ? 'ON' : 'OFF'}
            </button>
            {posterRgba ? (
              <>
                <button
                  className={`board-tool-btn ${showPosterUnderlay ? 'active' : ''}`}
                  onClick={() => setShowPosterUnderlay(!showPosterUnderlay)}
                  style={{
                    background: showPosterUnderlay ? '#238636' : undefined,
                    color: showPosterUnderlay ? '#fff' : undefined,
                    fontWeight: 'bold',
                  }}
                  title="Toggle Reference Poster background"
                >
                  {showPosterUnderlay ? 'POSTER ON' : 'POSTER OFF'}
                </button>
                {showPosterUnderlay && (
                  <input
                    type="range"
                    min="0.1"
                    max="1.0"
                    step="0.05"
                    value={posterOpacity}
                    onChange={(e) => setPosterOpacity(parseFloat(e.target.value))}
                    style={{ width: 60, accentColor: '#2ea043' }}
                    title={`Poster Opacity: ${(posterOpacity * 100).toFixed(0)}%`}
                  />
                )}
                <button
                  className="board-tool-btn"
                  onClick={() => fileInputRef.current?.click()}
                  title="Change reference poster image"
                >
                  CHANGE POSTER
                </button>
              </>
            ) : (
              <button
                className="board-tool-btn primary"
                onClick={() => fileInputRef.current?.click()}
                title="Load reference poster image"
                style={{ background: '#238636', borderColor: '#2ea043', color: '#fff' }}
              >
                LOAD POSTER
              </button>
            )}
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept="image/*"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const img = new Image()
                img.src = URL.createObjectURL(file)
                img.onload = () => {
                  if (onPosterIngested) {
                    onPosterIngested(img, file)
                  }
                }
              }}
            />
          </div>

          <canvas
            ref={canvasRef}
            className={`board-canvas-viewport ${isDragOver ? 'dragover' : ''}`}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onDragLeave={handleDragLeave}
            onClick={handleClick}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />

          {/* Hover HUD Overlay showing physical and pixel coordinates */}
          {/* {hoverSlot && (
            <div className="board-hud-overlay">
              <div className="board-hud-row">
                <span className="board-hud-label">SLOT:</span>
                <span className="board-hud-val highlight">[{hoverSlot.c}, {hoverSlot.r}]</span>
                <span className="board-hud-label">TYPE:</span>
                <span className={`board-hud-val ${(hoverSlot.r === 0 && hoverSlot.c === 0) ||
                  (hoverSlot.r === 0 && hoverSlot.c === cols - 1) ||
                  (hoverSlot.r === rows - 1 && hoverSlot.c === 0) ||
                  (hoverSlot.r === rows - 1 && hoverSlot.c === cols - 1)
                  ? 'red'
                  : hoverSlot.r === 0 || hoverSlot.r === rows - 1 || hoverSlot.c === 0 || hoverSlot.c === cols - 1
                    ? 'yellow'
                    : 'green'
                  }`}>
                  {(hoverSlot.r === 0 && hoverSlot.c === 0) ||
                    (hoverSlot.r === 0 && hoverSlot.c === cols - 1) ||
                    (hoverSlot.r === rows - 1 && hoverSlot.c === 0) ||
                    (hoverSlot.r === rows - 1 && hoverSlot.c === cols - 1)
                    ? 'CORNER'
                    : hoverSlot.r === 0 || hoverSlot.r === rows - 1 || hoverSlot.c === 0 || hoverSlot.c === cols - 1
                      ? 'BORDER'
                      : 'INTERIOR'}
                </span>
                {placedSlots[`${hoverSlot.r},${hoverSlot.c}`] && (
                  <span className="board-hud-val highlight-green">
                    [PIECE #{pieceMap.get(placedSlots[`${hoverSlot.r},${hoverSlot.c}`].piece_id)?.piece_number ?? '?'}]
                  </span>
                )}
              </div>
              {posterWidth > 0 && posterHeight > 0 && (
                <div className="board-hud-row">
                  <span className="board-hud-label">POSTER POS:</span>
                  <span className="board-hud-val">
                    X:{((hoverSlot.c + 0.5) * (posterWidth / cols)).toFixed(0)} Y:{((hoverSlot.r + 0.5) * (posterHeight / rows)).toFixed(0)} px
                  </span>
                </div>
              )}
              {physWidthMm > 0 && physHeightMm > 0 && (
                <div className="board-hud-row">
                  <span className="board-hud-label">PHYSICAL:</span>
                  <span className="board-hud-val">
                    X:{((hoverSlot.c + 0.5) * (physWidthMm / cols)).toFixed(1)} Y:{((hoverSlot.r + 0.5) * (physHeightMm / rows)).toFixed(1)} mm
                  </span>
                </div>
              )}
            </div>
          )} */}
        </div>

        {/* Slot Inspector Sidebar */}
        <div className="mode-c-inspector">
          <div className="inspector-header">
            <span className="inspector-title">SLOT INSPECTOR</span>
            {selectedSlot && (
              <button className="inspector-close-btn" onClick={() => onSelectSlot(null)}>CLOSE</button>
            )}
          </div>

          {selectedSlot ? (
            <div className="inspector-body">
              {/* Slot Badge */}
              <div className="inspector-slot-badge">
                <span className="slot-coords">SLOT [{selectedSlot.row}, {selectedSlot.col}]</span>
                <span className={`slot-type-badge ${selectedSlotReq?.is_corner ? 'corner' : selectedSlotReq?.is_border ? 'border' : 'interior'}`}>
                  {selectedSlotReq?.is_corner ? 'CORNER' : selectedSlotReq?.is_border ? 'BORDER' : 'INTERIOR'}
                </span>
              </div>

              {/* Placed Piece or Hole Preview */}
              {selectedSlotPlaced && selectedSlotPiece ? (
                <div className="placed-piece-detail">
                  <div className="placed-piece-header">
                    <strong>PIECE #{selectedSlotPiece.piece_number}</strong>
                    <span className="stat-badge placed">PLACED</span>
                  </div>
                  <img
                    src={selectedSlotPiece.thumbnailDataUrl}
                    alt={`Piece #${selectedSlotPiece.piece_number}`}
                    style={{ width: '100%', borderRadius: 4, border: '1px solid #30363d', cursor: onSelectPiecePreview ? 'pointer' : 'default' }}
                    onClick={() => onSelectPiecePreview?.(selectedSlotPiece)}
                    title="Click for full piece preview"
                  />
                  <div style={{ fontSize: 11, color: '#8b949e', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Rotation: {selectedSlotPlaced.rotation * 90}° CW</span>
                    <button
                      className="board-btn"
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      onClick={() => onPlacePiece(selectedSlot.row, selectedSlot.col, selectedSlotPlaced.piece_id, (selectedSlotPlaced.rotation + 1) % 4)}
                    >
                      ROTATE 90°
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button
                      className="unplace-btn"
                      style={{ flex: 1 }}
                      onClick={() => onUnplacePiece(selectedSlot.row, selectedSlot.col)}
                    >
                      UNPLACE
                    </button>
                    {onDeletePiece && (
                      <button
                        className="unplace-btn"
                        style={{ flex: 1, background: '#3a1d1d', borderColor: '#f85149', color: '#ff7b72' }}
                        onClick={() => {
                          if (confirm(`Permanently delete Piece #${selectedSlotPiece.piece_number} from database?`)) {
                            onDeletePiece(selectedSlotPiece.id)
                          }
                        }}
                      >
                        DELETE
                      </button>
                    )}
                  </div>

                  {/* Manual Mating Pair Overrides */}
                  <div className="inspector-artwork-section" style={{ marginTop: 12 }}>
                    <span className="inspector-label">MATING PAIRS</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                      {pairedFixtures
                        .filter(f => f.piece_a_id === selectedSlotPiece.id || f.piece_b_id === selectedSlotPiece.id)
                        .map(fix => {
                          const otherId = fix.piece_a_id === selectedSlotPiece.id ? fix.piece_b_id : fix.piece_a_id
                          const otherPiece = pieceMap.get(otherId)
                          const isVerified = fix.status === 'verified'
                          const isRejected = fix.status === 'rejected'

                          return (
                            <div key={fix.id} style={{
                              background: '#161b22',
                              border: `1px solid ${isVerified ? '#3fb950' : isRejected ? '#f85149' : '#d29922'}`,
                              borderRadius: 4,
                              padding: '6px 8px',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 4
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 11, fontWeight: 'bold' }}>
                                  Pair with #{otherPiece?.piece_number ?? otherId.slice(0, 5)}
                                </span>
                                <span style={{
                                  fontSize: 9,
                                  fontWeight: 'bold',
                                  padding: '1px 5px',
                                  borderRadius: 3,
                                  background: isVerified ? 'rgba(63, 185, 80, 0.2)' : isRejected ? 'rgba(248, 81, 73, 0.2)' : 'rgba(210, 153, 34, 0.2)',
                                  color: isVerified ? '#3fb950' : isRejected ? '#f85149' : '#d29922',
                                }}>
                                  {fix.status.toUpperCase()}
                                </span>
                              </div>
                              <div style={{ fontSize: 10, color: '#8b949e' }}>
                                {fix.notes || `Confidence: ${((fix.confidence_score ?? 0.8) * 100).toFixed(0)}%`}
                              </div>
                              {onUpdatePairStatus && (
                                <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                                  <button
                                    className="board-btn"
                                    style={{
                                      fontSize: 10,
                                      padding: '2px 8px',
                                      flex: 1,
                                      background: isVerified ? '#238636' : '#21262d',
                                      borderColor: isVerified ? '#3fb950' : '#30363d',
                                      color: isVerified ? '#ffffff' : '#3fb950',
                                    }}
                                    onClick={() => onUpdatePairStatus(fix.id, 'verified')}
                                  >
                                    CONFIRM
                                  </button>
                                  <button
                                    className="board-btn"
                                    style={{
                                      fontSize: 10,
                                      padding: '2px 8px',
                                      flex: 1,
                                      background: isRejected ? '#da3633' : '#21262d',
                                      borderColor: isRejected ? '#f85149' : '#30363d',
                                      color: isRejected ? '#ffffff' : '#f85149',
                                    }}
                                    onClick={() => onUpdatePairStatus(fix.id, 'rejected')}
                                  >
                                    REJECT
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      {pairedFixtures.filter(f => f.piece_a_id === selectedSlotPiece.id || f.piece_b_id === selectedSlotPiece.id).length === 0 && (
                        <div style={{ fontSize: 10, color: '#8b949e', fontStyle: 'italic' }}>
                          No adjacent placed pieces yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Expected Artwork Crop */}
                  <div className="inspector-artwork-section">
                    <span className="inspector-label">EXPECTED ARTWORK</span>
                    <div className="artwork-preview-card">
                      {activeSlotPreview ? (
                        <>
                          <canvas ref={cropCanvasRef} className="artwork-crop-canvas" />
                          <div className="artwork-color-cue">
                            <span
                              className="color-swatch"
                              style={{
                                backgroundColor: `rgb(${activeSlotPreview.mean_rgb[0]}, ${activeSlotPreview.mean_rgb[1]}, ${activeSlotPreview.mean_rgb[2]})`,
                              }}
                            />
                            <span>
                              RGB: [{activeSlotPreview.mean_rgb.join(', ')}]
                            </span>
                          </div>
                          {activeSlotPreview.mean_lab && (
                            <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#8b949e' }}>
                              LAB: L*{activeSlotPreview.mean_lab[0].toFixed(0)} a*{activeSlotPreview.mean_lab[1].toFixed(0)} b*{activeSlotPreview.mean_lab[2].toFixed(0)}
                            </div>
                          )}
                          <div style={{ fontSize: 10, color: '#8b949e', marginTop: 2 }}>
                            SIZE: {activeSlotPreview.width} × {activeSlotPreview.height} px
                            {physWidthMm > 0 && physHeightMm > 0 && (
                              <span> ({(physWidthMm / cols).toFixed(1)} × {(physHeightMm / rows).toFixed(1)} mm)</span>
                            )}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 11, color: '#8b949e', padding: '16px 0', textAlign: 'center' }}>
                          {posterRgba
                            ? 'Generating slot crop...'
                            : 'Upload reference poster to preview artwork crops.'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Required Edge Constraints */}
                  {selectedSlotReq && (
                    <div className="inspector-artwork-section">
                      <span className="inspector-label">REQUIRED EDGES</span>
                      <div className="edge-constraints-grid">
                        {(['NORTH', 'EAST', 'SOUTH', 'WEST'] as const).map((dir, idx) => {
                          const req = selectedSlotReq.required_edges[idx]
                          return (
                            <div key={dir} className="edge-constraint-card">
                              <span className="edge-dir">{dir}</span>
                              <span className={`edge-status ${req ? req.toLowerCase() : 'open'}`}>
                                {req ? req.toUpperCase() : 'ANY (OPEN)'}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <div className="inspector-help-hint">
                    Place piece under camera to match and place it into this slot.
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="inspector-help-hint" style={{ marginTop: 40 }}>
              Select any slot on the grid to inspect artwork previews and edge requirements.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
