import React, { useEffect, useRef, useState } from 'react'
import './BoardView.css'

export interface BoardSlot {
  row: number
  col: number
  piece_id: number | null
  rotation: number | null
  is_border: boolean
  is_corner: boolean
}

export interface SlotCandidate {
  row: number
  col: number
  rotation: number
  score: number
  reason: string
}

interface BoardViewProps {
  rows: number
  cols: number
  slots: BoardSlot[]
  candidates: SlotCandidate[]
  selectedCandidate: SlotCandidate | null
  onSelectCandidate: (candidate: SlotCandidate) => void
  onPlacePieceAtSlot: (candidate: SlotCandidate) => void
  onUnplacePiece: (row: number, col: number) => void
}

export const BoardView: React.FC<BoardViewProps> = ({
  rows,
  cols,
  slots,
  candidates,
  selectedCandidate,
  onSelectCandidate,
  onPlacePieceAtSlot,
  onUnplacePiece,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hoverSlot, setHoverSlot] = useState<{ r: number; c: number } | null>(null)

  // Map of candidate lookup: "r,c" -> SlotCandidate
  const candidateMap = React.useMemo(() => {
    const map = new Map<string, SlotCandidate>()
    for (const cand of candidates) {
      const key = `${cand.row},${cand.col}`
      if (!map.has(key) || (map.get(key)!.score < cand.score)) {
        map.set(key, cand)
      }
    }
    return map
  }, [candidates])

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)

    const cellW = width / cols
    const cellH = height / rows

    for (const slot of slots) {
      const x = slot.col * cellW
      const y = slot.row * cellH
      const cand = candidateMap.get(`${slot.row},${slot.col}`)
      const isSelected = selectedCandidate && selectedCandidate.row === slot.row && selectedCandidate.col === slot.col
      const isHovered = hoverSlot && hoverSlot.r === slot.row && hoverSlot.c === slot.col

      // Base background color
      if (slot.piece_id !== null) {
        // Placed piece: vibrant solid fill
        ctx.fillStyle = '#238636'
      } else if (isSelected) {
        // Highlight active candidate
        ctx.fillStyle = 'rgba(255, 211, 61, 0.45)'
      } else if (cand) {
        // Candidate fit slot
        const alpha = Math.min(0.65, Math.max(0.18, cand.score * 0.7))
        ctx.fillStyle = `rgba(56, 139, 253, ${alpha})`
      } else if (slot.is_corner) {
        ctx.fillStyle = 'rgba(248, 81, 73, 0.08)'
      } else if (slot.is_border) {
        ctx.fillStyle = 'rgba(210, 153, 34, 0.05)'
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.02)'
      }
      ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2)

      // Grid line borders
      ctx.strokeStyle = isSelected
        ? '#ffd33d'
        : cand
        ? '#58a6ff'
        : slot.is_corner
        ? 'rgba(248, 81, 73, 0.35)'
        : slot.is_border
        ? 'rgba(210, 153, 34, 0.25)'
        : 'rgba(255, 255, 255, 0.08)'
      ctx.lineWidth = isSelected ? 2 : cand ? 1.5 : 0.75
      ctx.strokeRect(x + 1, y + 1, cellW - 2, cellH - 2)

      // Cell text/labels if cells are large enough
      if (cellW >= 22 && cellH >= 18) {
        ctx.font = 'bold 9px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'

        if (slot.piece_id !== null) {
          ctx.fillStyle = '#ffffff'
          ctx.fillText(`P#${slot.piece_id}`, x + cellW / 2, y + cellH / 2)
        } else if (cand) {
          ctx.fillStyle = '#ffffff'
          ctx.fillText(`${(cand.score * 100).toFixed(0)}%`, x + cellW / 2, y + cellH / 2)
        }
      }

      if (isHovered && !isSelected) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1)
      }
    }
  }, [rows, cols, slots, candidateMap, selectedCandidate, hoverSlot])

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    const c = Math.floor((clickX / rect.width) * cols)
    const r = Math.floor((clickY / rect.height) * rows)

    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      const cand = candidateMap.get(`${r},${c}`)
      if (cand) {
        onSelectCandidate(cand)
      } else {
        const slot = slots.find((s) => s.row === r && s.col === c)
        if (slot && slot.piece_id !== null) {
          // Allow removing placed piece on double click or click
          if (confirm(`Remove placed Piece #${slot.piece_id} from slot (${r}, ${c})?`)) {
            onUnplacePiece(r, c)
          }
        }
      }
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const c = Math.floor(((e.clientX - rect.left) / rect.width) * cols)
    const r = Math.floor(((e.clientY - rect.top) / rect.height) * rows)
    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      setHoverSlot({ r, c })
    } else {
      setHoverSlot(null)
    }
  }

  const placedCount = slots.filter((s) => s.piece_id !== null).length
  const progressPct = ((placedCount / (rows * cols)) * 100).toFixed(1)

  return (
    <div className="board-view-container">
      <div className="board-header">
        <div className="board-title">
          <span>ASSEMBLY MATRIX [{cols}×{rows}]</span>
        </div>
        <div className="board-stats">
          <span className="stat-badge placed">PLACED: {placedCount} / {rows * cols} ({progressPct}%)</span>
          <span className="stat-badge candidates">{candidates.length} CANDIDATES</span>
        </div>
      </div>

      <div className="board-canvas-wrapper">
        <canvas
          ref={canvasRef}
          width={600}
          height={340}
          className="board-canvas"
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverSlot(null)}
        />
      </div>

      <div className="candidate-footer-area">
        {selectedCandidate ? (
          <div className="candidate-callout">
            <div className="candidate-meta">
              <span>SLOT: [{selectedCandidate.row}, {selectedCandidate.col}]</span>
              <span>CONFIDENCE: {(selectedCandidate.score * 100).toFixed(0)}%</span>
              <span>ROTATION: {selectedCandidate.rotation * 90}° CW</span>
            </div>
            <div className="candidate-reason">{selectedCandidate.reason.toUpperCase()}</div>
            <button
              className="place-btn"
              onClick={() => onPlacePieceAtSlot(selectedCandidate)}
            >
              LOCK TO SLOT [{selectedCandidate.row}, {selectedCandidate.col}]
            </button>
          </div>
        ) : candidates.length > 0 ? (
          <div className="candidate-list">
            <span className="candidate-list-title">SUGGESTED SLOTS:</span>
            {candidates.slice(0, 5).map((cand, idx) => (
              <button
                key={idx}
                className="candidate-chip"
                onClick={() => onSelectCandidate(cand)}
              >
                [{cand.row},{cand.col}] {(cand.score * 100).toFixed(0)}% ({cand.rotation * 90}°)
              </button>
            ))}
          </div>
        ) : (
          <div className="candidate-list-empty">
            <span>NO COMPATIBLE SLOTS DETECTED FOR CURRENT STAGE</span>
          </div>
        )}
      </div>
    </div>
  )
}
