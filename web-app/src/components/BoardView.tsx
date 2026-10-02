import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { StoredPiece, PlacedBoardSlot, GroundTruthPairFixture } from '../storage/db'
import type { SlotRequirementFilter } from './PieceTray'
import { get_slot_preview } from '../pkg/cv_engine'
import './BoardView.css'

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
  onSetSlotFilter: (filter: SlotRequirementFilter | null) => void
  onUpdatePairStatus?: (pairId: string, status: 'verified' | 'rejected') => void
  posterRgba: Uint8Array | null
  posterWidth: number
  posterHeight: number
  onExportFixtures: () => void
  onImportFixtures: () => void
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
  onSetSlotFilter,
  onUpdatePairStatus,
  posterRgba,
  posterWidth,
  posterHeight,
  onExportFixtures,
  onImportFixtures,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const cropCanvasRef = useRef<HTMLCanvasElement>(null)

  // Pan and Zoom transform state
  const [zoom, setZoom] = useState<number>(1.0)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 40, y: 40 })
  const isDraggingRef = useRef<boolean>(false)
  const lastMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const [hoverSlot, setHoverSlot] = useState<{ r: number; c: number } | null>(null)

  // Map piece_id -> StoredPiece for instant lookup
  const pieceMap = useMemo(() => {
    const map = new Map<string, StoredPiece>()
    for (const p of pieces) {
      map.set(p.id, p)
    }
    return map
  }, [pieces])

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

  // When selectedSlot changes, notify parent of slot filter requirement for PieceTray
  useEffect(() => {
    if (selectedSlot) {
      const req = computeSlotRequirement(selectedSlot.row, selectedSlot.col)
      onSetSlotFilter(req)
    } else {
      onSetSlotFilter(null)
    }
  }, [selectedSlot, computeSlotRequirement, onSetSlotFilter])

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

        // Cell border outline
        ctx.strokeStyle = isSelected
          ? '#ffd33d'
          : isHovered
          ? '#58a6ff'
          : is_corner
          ? 'rgba(248, 81, 73, 0.35)'
          : is_border
          ? 'rgba(210, 153, 34, 0.25)'
          : 'rgba(255, 255, 255, 0.07)'
        ctx.lineWidth = isSelected ? 2 / zoom : isHovered ? 1.5 / zoom : 0.75 / zoom
        ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2)

        // Piece number label on cell
        if (placed) {
          const piece = pieceMap.get(placed.piece_id)
          if (piece && cellW * zoom > 20) {
            ctx.fillStyle = '#ffffff'
            ctx.font = `bold ${Math.max(8, Math.min(11, 9 * zoom))}px monospace`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(`#${piece.piece_number}`, x + cellW / 2, y + cellH / 2)
          }
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
  }, [rows, cols, pan, zoom, placedSlots, selectedSlot, hoverSlot, pieceMap, pairedFixtures])

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
      if (selectedSlot && selectedSlot.row === r && selectedSlot.col === c) {
        onSelectSlot(null)
      } else {
        onSelectSlot({ row: r, col: c })
      }
    }
  }

  // Drag over handler for dropping pieces from PieceTray
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  // Drop piece from PieceTray onto board slot
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
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
        <div className="board-title">
          <span>ASSEMBLY MATRIX [{cols}×{rows}]</span>
          <div className="board-stats">
            <span className="stat-badge placed">PLACED: {placedCount} / {totalSlots} ({progressPct}%)</span>
            <span className="stat-badge unplaced">REMAINING: {totalSlots - placedCount}</span>
          </div>
        </div>

        <div className="board-header-actions">
          <button className="board-btn" onClick={onImportFixtures} title="Import saved assembly JSON dataset">
            IMPORT JSON
          </button>
          <button className="board-btn primary" onClick={onExportFixtures} title="Export ground-truth assembly fixtures for Phase 8">
            EXPORT JSON FIXTURES
          </button>
        </div>
      </div>

      {/* Main Board View: Interactive Canvas + Mode C Inspector */}
      <div className="board-main-layout">
        {/* Canvas Pane */}
        <div className="board-canvas-pane" ref={containerRef}>
          <div className="board-canvas-toolbar">
            <button className="board-tool-btn" onClick={() => setZoom((z) => Math.min(4.0, z * 1.25))}>+</button>
            <button className="board-tool-btn" onClick={() => setZoom((z) => Math.max(0.4, z * 0.8))}>−</button>
            <button className="board-tool-btn" onClick={() => { setZoom(1.0); setPan({ x: 40, y: 40 }) }}>RESET</button>
          </div>

          <canvas
            ref={canvasRef}
            className="board-canvas-viewport"
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onClick={handleClick}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          />
        </div>

        {/* Mode C Hole Inspector Sidebar */}
        <div className="mode-c-inspector">
          <div className="inspector-header">
            <span className="inspector-title">MODE C: HOLE TARGETING</span>
            {selectedSlot && (
              <button className="inspector-close-btn" onClick={() => onSelectSlot(null)}>✕</button>
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
                    <span className="stat-badge placed">LOCKED</span>
                  </div>
                  <img
                    src={selectedSlotPiece.thumbnailDataUrl}
                    alt={`Piece #${selectedSlotPiece.piece_number}`}
                    style={{ width: '100%', borderRadius: 4, border: '1px solid #30363d' }}
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
                  <button
                    className="unplace-btn"
                    onClick={() => onUnplacePiece(selectedSlot.row, selectedSlot.col)}
                  >
                    UNPLACE BACK TO TRAY
                  </button>

                  {/* Manual Mating Pair Overrides */}
                  <div className="inspector-artwork-section" style={{ marginTop: 12 }}>
                    <span className="inspector-label">PHYSICAL MATING PAIRS & OVERRIDES</span>
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
                                  Mate ↔ #{otherPiece?.piece_number ?? otherId.slice(0, 5)}
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
                                    ✓ CONFIRM
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
                                    ✕ REJECT
                                  </button>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      {pairedFixtures.filter(f => f.piece_a_id === selectedSlotPiece.id || f.piece_b_id === selectedSlotPiece.id).length === 0 && (
                        <div style={{ fontSize: 10, color: '#8b949e', fontStyle: 'italic' }}>
                          No adjacent placed pieces yet to form mating pairs.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* Expected Artwork Crop (Mode C) */}
                  <div className="inspector-artwork-section">
                    <span className="inspector-label">EXPECTED ARTWORK PREVIEW</span>
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
                        </>
                      ) : (
                        <div style={{ fontSize: 11, color: '#8b949e', padding: '16px 0', textAlign: 'center' }}>
                          {posterRgba
                            ? 'Generating slot crop...'
                            : 'Upload reference poster in [2] POSTER & GRID to unlock Mode C artwork previews.'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Required Edge Constraints */}
                  {selectedSlotReq && (
                    <div className="inspector-artwork-section">
                      <span className="inspector-label">REQUIRED EDGE SIGNATURES</span>
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
                    💡 The Piece Tray has been automatically filtered for pieces matching this slot. Drag a compatible piece from the tray onto this slot to lock it in!
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="inspector-help-hint" style={{ marginTop: 40 }}>
              Tap any slot on the grid to inspect missing piece requirements, trigger Mode C artwork previews, and filter your piece inventory.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
