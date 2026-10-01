import React, { useState, useMemo } from 'react'
import type { StoredPiece, StoredPieceEdge } from '../storage/db'
import './PieceTray.css'

export interface SlotRequirementFilter {
  row: number
  col: number
  is_border: boolean
  is_corner: boolean
  // Required edge types for [North, East, South, West]
  // null means unconstrained (no neighbor placed yet)
  required_edges: [
    ('Flat' | 'Tab' | 'Hole') | null,
    ('Flat' | 'Tab' | 'Hole') | null,
    ('Flat' | 'Tab' | 'Hole') | null,
    ('Flat' | 'Tab' | 'Hole') | null,
  ]
}

interface PieceTrayProps {
  pieces: StoredPiece[]
  selectedPieceId: string | null
  onSelectPiece: (piece: StoredPiece | null) => void
  onToggleFavorite: (pieceId: string) => void
  onDeletePiece: (pieceId: string) => void
  onClearAllPieces: () => void
  slotFilter: SlotRequirementFilter | null
  onClearSlotFilter: () => void
  onStartPairingWith?: (pieceId: string) => void
  pairingSourcePieceId?: string | null
  onCancelPairing?: () => void
}

export const PieceTray: React.FC<PieceTrayProps> = ({
  pieces,
  selectedPieceId,
  onSelectPiece,
  onToggleFavorite,
  onDeletePiece,
  onClearAllPieces,
  slotFilter,
  onClearSlotFilter,
  onStartPairingWith,
  pairingSourcePieceId,
  onCancelPairing,
}) => {
  const [filterType, setFilterType] = useState<'All' | 'Corners' | 'Borders' | 'Interior' | 'Favorites'>('All')
  const [searchQuery, setSearchQuery] = useState<string>('')

  // Determine if a piece can fit into a slot under any of the 4 rotations (0, 90, 180, 270 deg)
  const pieceMatchesSlot = (piece: StoredPiece, reqs: SlotRequirementFilter): boolean => {
    // If slot is corner or border, piece must match classification
    if (reqs.is_corner && piece.classification !== 'Corner') return false
    if (!reqs.is_corner && reqs.is_border && piece.classification !== 'Border') return false
    if (!reqs.is_border && piece.classification !== 'Interior') return false

    // Check 4 rotational orientations (rot = 0, 1, 2, 3)
    // Edge array order is [Top (N), Right (E), Bottom (S), Left (W)]
    const edgeTypes = piece.edges.map((e) => e.edge_type)

    for (let rot = 0; rot < 4; rot++) {
      let satisfies = true
      for (let side = 0; side < 4; side++) {
        const required = reqs.required_edges[side]
        if (required !== null) {
          // Under rotation `rot` (clockwise steps of 90 deg):
          // side 0 (N) comes from (side - rot + 4) % 4
          const pieceEdgeIdx = (side - rot + 4) % 4
          if (edgeTypes[pieceEdgeIdx] !== required) {
            satisfies = false
            break
          }
        }
      }
      if (satisfies) return true
    }
    return false
  }

  // Filter & Search Logic
  const filteredPieces = useMemo(() => {
    return pieces.filter((p) => {
      // 1. Classification / Tab Filter
      if (filterType === 'Corners' && p.classification !== 'Corner') return false
      if (filterType === 'Borders' && p.classification !== 'Border') return false
      if (filterType === 'Interior' && p.classification !== 'Interior') return false
      if (filterType === 'Favorites' && !p.is_favorite) return false

      // 2. Mode C Slot Requirement Filter
      if (slotFilter && !pieceMatchesSlot(p, slotFilter)) {
        return false
      }

      // 3. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim()
        const matchNum = `#${p.piece_number}`.includes(q) || p.piece_number.toString() === q
        const matchTag = p.tags.some((t) => t.toLowerCase().includes(q))
        const matchClass = p.classification.toLowerCase().includes(q)
        if (!matchNum && !matchTag && !matchClass) return false
      }

      return true
    })
  }, [pieces, filterType, slotFilter, searchQuery])

  // Drag-and-drop start handler
  const handleDragStart = (e: React.DragEvent, piece: StoredPiece) => {
    e.dataTransfer.setData('application/json', JSON.stringify({
      piece_id: piece.id,
      piece_number: piece.piece_number,
      classification: piece.classification,
    }))
    e.dataTransfer.effectAllowed = 'move'
  }

  const renderEdgeCode = (edge: StoredPieceEdge, label: string) => {
    const symbol = edge.edge_type === 'Tab' ? '▲' : edge.edge_type === 'Hole' ? '▼' : '—'
    const cls = edge.edge_type.toLowerCase()
    return (
      <span className={`edge-sig-item ${cls}`} title={`${label}: ${edge.edge_type}`}>
        {label}:{symbol}
      </span>
    )
  }

  return (
    <div className="piece-tray-container">
      {/* Header */}
      <div className="piece-tray-header">
        <div className="tray-title-group">
          <span className="tray-title">PIECE TRAY</span>
          <span className="tray-count-badge">
            {filteredPieces.length} / {pieces.length}
          </span>
        </div>
        <div className="tray-header-actions">
          {pieces.length > 0 && (
            <button
              className="tray-btn-tiny danger"
              onClick={() => {
                if (confirm(`Clear all ${pieces.length} pieces from inventory? This cannot be undone.`)) {
                  onClearAllPieces()
                }
              }}
              title="Clear all stored pieces"
            >
              CLEAR ALL
            </button>
          )}
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="piece-tray-filters">
        <div className="filter-pills">
          {(['All', 'Corners', 'Borders', 'Interior', 'Favorites'] as const).map((type) => (
            <button
              key={type}
              className={`filter-pill ${filterType === type ? 'active' : ''}`}
              onClick={() => setFilterType(type)}
            >
              {type.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="filter-search-row">
          <input
            type="text"
            className="filter-search-input"
            placeholder="Search piece # or tag..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="tray-btn-tiny" onClick={() => setSearchQuery('')}>
              ✕
            </button>
          )}
        </div>

        {/* Mode C Slot Compatibility Banner */}
        {slotFilter && (
          <div className="slot-filter-banner">
            <span>
              🎯 FILTERED FOR SLOT [{slotFilter.row}, {slotFilter.col}]
            </span>
            <button className="clear-slot-filter" onClick={onClearSlotFilter} title="Clear slot filter">
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Pairing Active Notification */}
      {pairingSourcePieceId && (
        <div className="pairing-active-bar">
          <span>Click a 2nd piece to pair with #{pieces.find(p => p.id === pairingSourcePieceId)?.piece_number}</span>
          {onCancelPairing && <button onClick={onCancelPairing}>CANCEL</button>}
        </div>
      )}

      {/* Grid List of Pieces */}
      <div className="piece-tray-list">
        {filteredPieces.length === 0 ? (
          <div className="piece-tray-empty">
            {pieces.length === 0
              ? 'No pieces scanned yet. Scan pieces via Camera [Mode A] to populate the tray.'
              : 'No pieces match current filter/slot criteria.'}
          </div>
        ) : (
          filteredPieces.map((piece) => {
            const isSelected = selectedPieceId === piece.id
            const isPlaced = piece.status === 'Placed'

            return (
              <div
                key={piece.id}
                className={`piece-card ${isSelected ? 'selected' : ''} ${piece.is_favorite ? 'is-favorite' : ''} ${isPlaced ? 'is-placed' : ''}`}
                draggable={!isPlaced}
                onDragStart={(e) => handleDragStart(e, piece)}
                onClick={() => onSelectPiece(isSelected ? null : piece)}
              >
                {/* Header */}
                <div className="piece-card-header">
                  <span className="piece-num-badge">#{piece.piece_number}</span>
                  <div className="piece-badges">
                    <span className={`badge-tag ${piece.classification.toLowerCase()}`}>
                      {piece.classification}
                    </span>
                    <button
                      className={`fav-star-btn ${piece.is_favorite ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleFavorite(piece.id)
                      }}
                      title="Toggle Favorite"
                    >
                      ★
                    </button>
                  </div>
                </div>

                {/* Thumbnail */}
                <div className="piece-thumb-wrap">
                  <img
                    src={piece.thumbnailDataUrl}
                    alt={`Piece #${piece.piece_number}`}
                    className="piece-thumb-img"
                    loading="lazy"
                  />
                  {isPlaced && piece.placed_slot && (
                    <div className="placed-watermark">
                      LOCKED [{piece.placed_slot.row},{piece.placed_slot.col}]
                    </div>
                  )}
                </div>

                {/* Edge Signatures [N, E, S, W] */}
                <div className="piece-edge-strip">
                  {renderEdgeCode(piece.edges[0], 'N')}
                  {renderEdgeCode(piece.edges[1], 'E')}
                  {renderEdgeCode(piece.edges[2], 'S')}
                  {renderEdgeCode(piece.edges[3], 'W')}
                </div>

                {/* Footer / Dimensions & Actions */}
                <div className="piece-card-footer">
                  <span className="piece-dims">
                    {piece.metric_width_mm.toFixed(1)}×{piece.metric_height_mm.toFixed(1)}mm
                  </span>
                  <div className="piece-card-actions">
                    {onStartPairingWith && !pairingSourcePieceId && (
                      <button
                        className="card-action-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          onStartPairingWith(piece.id)
                        }}
                        title="Designate manual mating pair fixture"
                      >
                        🔗
                      </button>
                    )}
                    <button
                      className="card-action-btn delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`Delete Piece #${piece.piece_number} from tray?`)) {
                          onDeletePiece(piece.id)
                        }
                      }}
                      title="Delete piece"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
