import React, { useEffect, useRef, useState, useCallback } from 'react'
import { process_poster_rgba, get_poster_grid_slots } from '../pkg/cv_engine'
import './PosterCanvas.css'

export interface PosterSlotData {
  col: number
  row: number
  min_x_px: number
  min_y_px: number
  max_x_px: number
  max_y_px: number
  center_x_px: number
  center_y_px: number
  center_x_mm: number
  center_y_mm: number
  is_border: boolean
  is_corner: boolean
}

export interface PosterPyramidLevel {
  level: number
  width: number
  height: number
  scale: number
  pixels: Uint8Array
}

export interface MasterPosterData {
  metadata: {
    total_pieces: number
    grid_cols: number
    grid_rows: number
    physical_width_mm: number
    physical_height_mm: number
    original_width_px: number
    original_height_px: number
    cell_width_px: number
    cell_height_px: number
    cell_width_mm: number
    cell_height_mm: number
  }
  pyramids: PosterPyramidLevel[]
}

interface PosterCanvasProps {
  wasmReady: boolean
  onPosterIngested?: (poster: MasterPosterData, imageElement: HTMLImageElement) => void
}

export const PosterCanvas: React.FC<PosterCanvasProps> = ({
  wasmReady,
  onPosterIngested,
}) => {
  // Metadata state initialized to user puzzle specification:
  // 1008 pieces, 70 x 50 cm (= 700 x 500 mm), grid layout 36 cols x 28 rows (= 1008)
  const [totalPieces, setTotalPieces] = useState<number>(1008)
  const [gridCols, setGridCols] = useState<number>(36)
  const [gridRows, setGridRows] = useState<number>(28)
  const [physWidthMm, setPhysWidthMm] = useState<number>(700)
  const [physHeightMm, setPhysHeightMm] = useState<number>(500)

  // Image & WASM state
  const [posterImage, setPosterImage] = useState<HTMLImageElement | null>(null)
  const [imageFileName, setImageFileName] = useState<string>('')
  const [masterPoster, setMasterPoster] = useState<MasterPosterData | null>(null)
  const [gridSlots, setGridSlots] = useState<PosterSlotData[]>([])
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Viewport transforms (Pan & Zoom)
  const [zoom, setZoom] = useState<number>(1)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [isDragOver, setIsDragOver] = useState<boolean>(false)

  // Display toggles
  const [showGrid, setShowGrid] = useState<boolean>(true)
  const [showCoordinates, setShowCoordinates] = useState<boolean>(false)
  const [hoverSlot, setHoverSlot] = useState<PosterSlotData | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Process image pixels with WASM
  const ingestImage = useCallback((img: HTMLImageElement, name: string) => {
    setImageFileName(name)
    setPosterImage(img)
    setErrorMessage(null)

    if (!wasmReady) {
      setErrorMessage('WASM engine not ready yet')
      return
    }

    setIsProcessing(true)

    // Render image to offscreen canvas to extract clean RGBA buffer
    const offscreen = document.createElement('canvas')
    offscreen.width = img.naturalWidth
    offscreen.height = img.naturalHeight
    const ctx = offscreen.getContext('2d')
    if (!ctx) {
      setErrorMessage('Failed to create offscreen canvas context')
      setIsProcessing(false)
      return
    }

    ctx.drawImage(img, 0, 0)
    const imgData = ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight)

    try {
      // Ingest poster buffer into Rust WASM memory (downsamples & builds pyramids)
      const poster = process_poster_rgba(
        new Uint8Array(imgData.data.buffer),
        img.naturalWidth,
        img.naturalHeight,
        totalPieces,
        gridCols,
        gridRows,
        physWidthMm,
        physHeightMm,
        5 // up to 5 levels
      ) as MasterPosterData

      setMasterPoster(poster)

      // Compute grid slots
      const slots = get_poster_grid_slots(
        gridCols,
        gridRows,
        img.naturalWidth,
        img.naturalHeight,
        physWidthMm,
        physHeightMm
      ) as PosterSlotData[]

      setGridSlots(slots)

      // Fit to view
      if (containerRef.current) {
        const cw = containerRef.current.clientWidth
        const ch = containerRef.current.clientHeight
        const scaleX = (cw - 32) / img.naturalWidth
        const scaleY = (ch - 32) / img.naturalHeight
        const initialZoom = Math.min(scaleX, scaleY, 1)
        setZoom(initialZoom)
        setPan({
          x: (cw - img.naturalWidth * initialZoom) / 2,
          y: (ch - img.naturalHeight * initialZoom) / 2,
        })
      }

      if (onPosterIngested) {
        onPosterIngested(poster, img)
      }
    } catch (err: any) {
      console.error('Poster ingestion failed:', err)
      setErrorMessage(err.message || String(err))
    } finally {
      setIsProcessing(false)
    }
  }, [wasmReady, totalPieces, gridCols, gridRows, physWidthMm, physHeightMm, onPosterIngested])

  // Recalculate grid when metadata changes
  const handleUpdateGridDimensions = () => {
    if (!posterImage || !wasmReady) return
    try {
      const slots = get_poster_grid_slots(
        gridCols,
        gridRows,
        posterImage.naturalWidth,
        posterImage.naturalHeight,
        physWidthMm,
        physHeightMm
      ) as PosterSlotData[]
      setGridSlots(slots)
    } catch (err: any) {
      console.error('Update grid failed:', err)
    }
  }

  // File loading
  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Selected file is not an image')
      return
    }
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        ingestImage(img, file.name)
      }
      img.onerror = () => {
        setErrorMessage('Failed to decode image file')
      }
      img.src = e.target?.result as string
    }
    reader.readAsDataURL(file)
  }

  // Drag-and-drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0])
    }
  }

  // Mouse pan and zoom
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 0) { // left click
      setIsDragging(true)
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
    }
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDragging) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      })
    }

    // Inspect hovered slot
    if (posterImage && canvasRef.current && gridSlots.length > 0) {
      const rect = canvasRef.current.getBoundingClientRect()
      const mouseCanvasX = e.clientX - rect.left
      const mouseCanvasY = e.clientY - rect.top

      // Map canvas coord back to original image space
      const imgX = (mouseCanvasX - pan.x) / zoom
      const imgY = (mouseCanvasY - pan.y) / zoom

      if (imgX >= 0 && imgX < posterImage.naturalWidth && imgY >= 0 && imgY < posterImage.naturalHeight) {
        const cellW = posterImage.naturalWidth / gridCols
        const cellH = posterImage.naturalHeight / gridRows
        const col = Math.floor(imgX / cellW)
        const row = Math.floor(imgY / cellH)
        const slotIdx = row * gridCols + col
        if (slotIdx >= 0 && slotIdx < gridSlots.length) {
          setHoverSlot(gridSlots[slotIdx])
          return
        }
      }
      setHoverSlot(null)
    }
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87
    const newZoom = Math.min(Math.max(zoom * zoomFactor, 0.05), 20.0)

    if (canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      // Zoom centered on cursor
      const newPanX = mouseX - (mouseX - pan.x) * (newZoom / zoom)
      const newPanY = mouseY - (mouseY - pan.y) * (newZoom / zoom)

      setZoom(newZoom)
      setPan({ x: newPanX, y: newPanY })
    }
  }

  const handleResetView = () => {
    if (posterImage && containerRef.current) {
      const cw = containerRef.current.clientWidth
      const ch = containerRef.current.clientHeight
      const scaleX = (cw - 32) / posterImage.naturalWidth
      const scaleY = (ch - 32) / posterImage.naturalHeight
      const initialZoom = Math.min(scaleX, scaleY, 1)
      setZoom(initialZoom)
      setPan({
        x: (cw - posterImage.naturalWidth * initialZoom) / 2,
        y: (ch - posterImage.naturalHeight * initialZoom) / 2,
      })
    }
  }

  // Main canvas render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !containerRef.current) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Sync canvas internal resolution with DOM container size
    const width = containerRef.current.clientWidth
    const height = containerRef.current.clientHeight
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    ctx.clearRect(0, 0, width, height)

    // Dark grid background for canvas
    ctx.fillStyle = '#06080a'
    ctx.fillRect(0, 0, width, height)

    if (!posterImage) return

    ctx.save()
    // Apply pan and zoom
    ctx.translate(pan.x, pan.y)
    ctx.scale(zoom, zoom)

    // Render master poster image
    ctx.drawImage(posterImage, 0, 0)

    // Render coordinate grid overlay
    if (showGrid && gridSlots.length > 0) {
      const cellW = posterImage.naturalWidth / gridCols
      const cellH = posterImage.naturalHeight / gridRows

      // Draw all grid lines
      ctx.lineWidth = 1 / zoom
      for (const slot of gridSlots) {
        const isHover = hoverSlot && hoverSlot.col === slot.col && hoverSlot.row === slot.row

        if (isHover) {
          ctx.fillStyle = 'rgba(0, 229, 255, 0.28)'
          ctx.fillRect(slot.min_x_px, slot.min_y_px, cellW, cellH)
        } else if (slot.is_corner) {
          ctx.fillStyle = 'rgba(248, 81, 73, 0.08)'
          ctx.fillRect(slot.min_x_px, slot.min_y_px, cellW, cellH)
        } else if (slot.is_border) {
          ctx.fillStyle = 'rgba(210, 153, 34, 0.05)'
          ctx.fillRect(slot.min_x_px, slot.min_y_px, cellW, cellH)
        }

        ctx.strokeStyle = isHover
          ? '#00e5ff'
          : slot.is_corner
          ? 'rgba(248, 81, 73, 0.7)'
          : slot.is_border
          ? 'rgba(210, 153, 34, 0.5)'
          : 'rgba(255, 255, 255, 0.18)'

        ctx.strokeRect(slot.min_x_px, slot.min_y_px, cellW, cellH)

        // Show slot coordinates if enabled or hovered
        if (showCoordinates || isHover) {
          const fontSize = Math.max(8, Math.min(13, cellH * 0.3))
          ctx.font = `bold ${fontSize}px monospace`
          ctx.fillStyle = isHover ? '#00e5ff' : 'rgba(255, 255, 255, 0.75)'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(`[${slot.col},${slot.row}]`, slot.center_x_px, slot.center_y_px)
        }
      }
    }

    ctx.restore()
  }, [posterImage, pan, zoom, showGrid, showCoordinates, gridSlots, hoverSlot, gridCols, gridRows])

  // Nominal cell dimensions
  const cellWmm = gridCols > 0 ? (physWidthMm / gridCols).toFixed(1) : '0'
  const cellHmm = gridRows > 0 ? (physHeightMm / gridRows).toFixed(1) : '0'
  const cellWpx = posterImage && gridCols > 0 ? (posterImage.naturalWidth / gridCols).toFixed(1) : '0'
  const cellHpx = posterImage && gridRows > 0 ? (posterImage.naturalHeight / gridRows).toFixed(1) : '0'

  return (
    <div className="poster-canvas-container">
      {/* Header */}
      <div className="poster-header">
        <div className="poster-title-row">
          <strong>POSTER REFERENCE &amp; COORDINATE GRID</strong>
          {imageFileName && <span className="badge">{imageFileName}</span>}
          {masterPoster && (
            <span className="badge">
              {masterPoster.metadata.original_width_px}x{masterPoster.metadata.original_height_px}px
            </span>
          )}
        </div>

        <div className="poster-actions">
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            accept="image/*"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                handleFile(e.target.files[0])
              }
            }}
          />
          <button
            className="btn small primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessing}
          >
            {posterImage ? 'REPLACE POSTER' : 'UPLOAD POSTER'}
          </button>
        </div>
      </div>

      {/* Metadata Configuration Bar */}
      <div className="poster-form-bar">
        <div className="form-group">
          <label>PIECES:</label>
          <input
            type="number"
            value={totalPieces}
            onChange={(e) => setTotalPieces(parseInt(e.target.value) || 0)}
          />
        </div>

        <div className="form-group">
          <label>GRID (CxR):</label>
          <input
            type="number"
            value={gridCols}
            title="Columns"
            onChange={(e) => setGridCols(parseInt(e.target.value) || 0)}
          />
          <span className="unit">x</span>
          <input
            type="number"
            value={gridRows}
            title="Rows"
            onChange={(e) => setGridRows(parseInt(e.target.value) || 0)}
          />
          <button className="btn tiny" onClick={handleUpdateGridDimensions}>
            APPLY GRID
          </button>
        </div>

        <div className="form-group">
          <label>PHYSICAL (WxH):</label>
          <input
            type="number"
            value={physWidthMm}
            title="Width in mm"
            onChange={(e) => setPhysWidthMm(parseFloat(e.target.value) || 0)}
          />
          <span className="unit">x</span>
          <input
            type="number"
            value={physHeightMm}
            title="Height in mm"
            onChange={(e) => setPhysHeightMm(parseFloat(e.target.value) || 0)}
          />
          <span className="unit">mm</span>
        </div>

        <div className="toolbar-info">
          SLOT: <b>{cellWmm}x{cellHmm} mm</b> ({cellWpx}x{cellHpx} px)
        </div>
      </div>

      {/* Toolbar */}
      <div className="poster-toolbar">
        <div className="toolbar-left">
          <button
            className={`btn tiny ${showGrid ? 'btn-toggle-active' : ''}`}
            onClick={() => setShowGrid(!showGrid)}
          >
            GRID OVERLAY: {showGrid ? 'ON' : 'OFF'}
          </button>
          <button
            className={`btn tiny ${showCoordinates ? 'btn-toggle-active' : ''}`}
            onClick={() => setShowCoordinates(!showCoordinates)}
          >
            COORDINATES: {showCoordinates ? 'SHOW' : 'HIDE'}
          </button>
          <button className="btn tiny" onClick={handleResetView} disabled={!posterImage}>
            RESET VIEW
          </button>
          <span className="toolbar-info">ZOOM: <b>{(zoom * 100).toFixed(0)}%</b></span>
        </div>

        <div className="toolbar-right">
          {masterPoster && (
            <span className="toolbar-info">
              PYRAMID: <b>{masterPoster.pyramids.length} LVLS</b>
            </span>
          )}
          {errorMessage && <span className="red">ERROR: {errorMessage}</span>}
        </div>
      </div>

      {/* Interactive Pan/Zoom Canvas Area */}
      <div
        ref={containerRef}
        className={`poster-dropzone ${isDragOver ? 'dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {!posterImage ? (
          <div className="poster-empty-placeholder">
            <div className="placeholder-icon">🖼️</div>
            <div className="placeholder-text">DROP MASTER POSTER / BOX IMAGE HERE</div>
            <div className="placeholder-subtext">
              Upload the reference puzzle artwork or box scan to generate the visual coordinate space and ground-truth slot grid.
              Default spec: 1008 pieces, 700x500 mm (36x28 grid).
            </div>
            <button
              className="btn primary"
              onClick={() => fileInputRef.current?.click()}
            >
              BROWSE FILE
            </button>
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="poster-viewport-canvas"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onWheel={handleWheel}
            />

            {hoverSlot && (
              <div className="poster-hud-overlay">
                <div className="hud-row">
                  <span className="hud-label">SLOT:</span>
                  <span className="hud-val highlight">[{hoverSlot.col}, {hoverSlot.row}]</span>
                  <span className="hud-label">TYPE:</span>
                  <span className={`hud-val ${hoverSlot.is_corner ? 'red' : hoverSlot.is_border ? 'yellow' : 'green'}`}>
                    {hoverSlot.is_corner ? 'CORNER' : hoverSlot.is_border ? 'BORDER' : 'INTERIOR'}
                  </span>
                </div>
                <div className="hud-row">
                  <span className="hud-label">POSTER POS:</span>
                  <span className="hud-val">
                    X:{hoverSlot.center_x_px.toFixed(0)} Y:{hoverSlot.center_y_px.toFixed(0)} px
                  </span>
                </div>
                <div className="hud-row">
                  <span className="hud-label">PHYSICAL:</span>
                  <span className="hud-val">
                    X:{hoverSlot.center_x_mm.toFixed(1)} Y:{hoverSlot.center_y_mm.toFixed(1)} mm
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
