/**
 * IndexedDB storage engine for Jigsaw Puzzle Solver.
 * Manages persistent pieces, board slot placements, and ground-truth pairing fixtures.
 * Zero external dependencies.
 */

export interface StoredPieceEdge {
  edge_type: 'Flat' | 'Tab' | 'Hole'
  start_corner: { x: number; y: number }
  end_corner: { x: number; y: number }
  curvature_depth: number
  curve_samples?: { x: number; y: number }[]
  normalized_profile?: number[]
  fourier_descriptor?: number[]
}

export interface StoredPiece {
  id: string
  piece_number: number
  timestamp: number
  thumbnailDataUrl: string
  corners: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }]
  edges: [StoredPieceEdge, StoredPieceEdge, StoredPieceEdge, StoredPieceEdge]
  bounding_width_px: number
  bounding_height_px: number
  metric_width_mm: number
  metric_height_mm: number
  classification: 'Corner' | 'Border' | 'Interior'
  flat_count: number
  tab_count: number
  hole_count: number
  status: 'InTray' | 'Placed'
  placed_slot: { row: number; col: number; rotation: number } | null
  is_favorite: boolean
  tags: string[]
  paired_piece_id: string | null
}

export interface PlacedBoardSlot {
  row: number
  col: number
  piece_id: string
  rotation: number // 0, 1, 2, 3 representing 0, 90, 180, 270 deg CW
  placed_at: number
}

export interface GroundTruthPairFixture {
  id: string
  piece_a_id: string
  piece_a_edge_idx: number // 0: Top, 1: Right, 2: Bottom, 3: Left
  piece_b_id: string
  piece_b_edge_idx: number
  created_at: number
  notes?: string
}

export interface BoardConfig {
  rows: number
  cols: number
  physical_width_mm: number
  physical_height_mm: number
}

const DB_NAME = 'JigsawSolverDB'
const DB_VERSION = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      if (!db.objectStoreNames.contains('pieces')) {
        const pieceStore = db.createObjectStore('pieces', { keyPath: 'id' })
        pieceStore.createIndex('timestamp', 'timestamp', { unique: false })
        pieceStore.createIndex('status', 'status', { unique: false })
        pieceStore.createIndex('classification', 'classification', { unique: false })
        pieceStore.createIndex('piece_number', 'piece_number', { unique: true })
      }

      if (!db.objectStoreNames.contains('board_slots')) {
        db.createObjectStore('board_slots', { keyPath: 'slot_key' }) // key: `${row},${col}`
      }

      if (!db.objectStoreNames.contains('paired_fixtures')) {
        db.createObjectStore('paired_fixtures', { keyPath: 'id' })
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ----------------- Pieces API -----------------

export async function getAllPieces(): Promise<StoredPiece[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pieces', 'readonly')
    const store = tx.objectStore('pieces')
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

export async function getPieceById(id: string): Promise<StoredPiece | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pieces', 'readonly')
    const store = tx.objectStore('pieces')
    const request = store.get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function savePiece(piece: StoredPiece): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pieces', 'readwrite')
    const store = tx.objectStore('pieces')
    const request = store.put(piece)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function deletePiece(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pieces', 'board_slots'], 'readwrite')
    const pieceStore = tx.objectStore('pieces')
    const boardStore = tx.objectStore('board_slots')

    pieceStore.delete(id)

    // Also unplace from any board slot
    const cursorReq = boardStore.openCursor()
    cursorReq.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest).result
      if (cursor) {
        if (cursor.value.piece_id === id) {
          cursor.delete()
        }
        cursor.continue()
      }
    }

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearAllPieces(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pieces', 'board_slots', 'paired_fixtures'], 'readwrite')
    tx.objectStore('pieces').clear()
    tx.objectStore('board_slots').clear()
    tx.objectStore('paired_fixtures').clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ----------------- Board Slots API -----------------

export async function getAllPlacedSlots(): Promise<Record<string, PlacedBoardSlot>> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('board_slots', 'readonly')
    const store = tx.objectStore('board_slots')
    const request = store.getAll()
    request.onsuccess = () => {
      const map: Record<string, PlacedBoardSlot> = {}
      for (const item of request.result || []) {
        map[`${item.row},${item.col}`] = item
      }
      resolve(map)
    }
    request.onerror = () => reject(request.error)
  })
}

export async function placePieceOnBoard(row: number, col: number, piece_id: string, rotation: number): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pieces', 'board_slots'], 'readwrite')
    const pieceStore = tx.objectStore('pieces')
    const boardStore = tx.objectStore('board_slots')

    // 1. Update board slot record
    const slotKey = `${row},${col}`
    boardStore.put({
      slot_key: slotKey,
      row,
      col,
      piece_id,
      rotation,
      placed_at: Date.now(),
    })

    // 2. Update piece status
    const getPieceReq = pieceStore.get(piece_id)
    getPieceReq.onsuccess = () => {
      const piece = getPieceReq.result as StoredPiece | undefined
      if (piece) {
        piece.status = 'Placed'
        piece.placed_slot = { row, col, rotation }
        pieceStore.put(piece)
      }
    }

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function unplacePieceFromBoard(row: number, col: number): Promise<string | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pieces', 'board_slots'], 'readwrite')
    const pieceStore = tx.objectStore('pieces')
    const boardStore = tx.objectStore('board_slots')
    const slotKey = `${row},${col}`

    let unplacedPieceId: string | null = null

    const getReq = boardStore.get(slotKey)
    getReq.onsuccess = () => {
      const item = getReq.result
      if (item) {
        unplacedPieceId = item.piece_id
        boardStore.delete(slotKey)
        if (unplacedPieceId) {
          const pieceReq = pieceStore.get(unplacedPieceId)
          pieceReq.onsuccess = () => {
            const piece = pieceReq.result as StoredPiece | undefined
            if (piece) {
              piece.status = 'InTray'
              piece.placed_slot = null
              pieceStore.put(piece)
            }
          }
        }
      }
    }

    tx.oncomplete = () => resolve(unplacedPieceId)
    tx.onerror = () => reject(tx.error)
  })
}

// ----------------- Ground Truth Pairing Fixtures API -----------------

export async function getAllPairedFixtures(): Promise<GroundTruthPairFixture[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('paired_fixtures', 'readonly')
    const store = tx.objectStore('paired_fixtures')
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

export async function savePairedFixture(fixture: GroundTruthPairFixture): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['paired_fixtures', 'pieces'], 'readwrite')
    const fixStore = tx.objectStore('paired_fixtures')
    const pieceStore = tx.objectStore('pieces')

    fixStore.put(fixture)

    // Mark both pieces as paired
    const reqA = pieceStore.get(fixture.piece_a_id)
    reqA.onsuccess = () => {
      const pieceA = reqA.result as StoredPiece | undefined
      if (pieceA) {
        pieceA.paired_piece_id = fixture.piece_b_id
        pieceStore.put(pieceA)
      }
    }

    const reqB = pieceStore.get(fixture.piece_b_id)
    reqB.onsuccess = () => {
      const pieceB = reqB.result as StoredPiece | undefined
      if (pieceB) {
        pieceB.paired_piece_id = fixture.piece_a_id
        pieceStore.put(pieceB)
      }
    }

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function deletePairedFixture(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['paired_fixtures', 'pieces'], 'readwrite')
    const fixStore = tx.objectStore('paired_fixtures')
    const pieceStore = tx.objectStore('pieces')

    const getReq = fixStore.get(id)
    getReq.onsuccess = () => {
      const fix = getReq.result as GroundTruthPairFixture | undefined
      if (fix) {
        fixStore.delete(id)
        // Clear paired_piece_id on pieces if still linked
        const reqA = pieceStore.get(fix.piece_a_id)
        reqA.onsuccess = () => {
          const p = reqA.result
          if (p && p.paired_piece_id === fix.piece_b_id) {
            p.paired_piece_id = null
            pieceStore.put(p)
          }
        }
        const reqB = pieceStore.get(fix.piece_b_id)
        reqB.onsuccess = () => {
          const p = reqB.result
          if (p && p.paired_piece_id === fix.piece_a_id) {
            p.paired_piece_id = null
            pieceStore.put(p)
          }
        }
      }
    }

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// ----------------- Export / Import Helpers -----------------

export interface AssemblyExportBundle {
  version: string
  exported_at: string
  board_config?: BoardConfig
  pieces: StoredPiece[]
  placed_slots: Record<string, PlacedBoardSlot>
  paired_fixtures: GroundTruthPairFixture[]
}

export async function exportAssemblyDataset(boardConfig?: BoardConfig): Promise<AssemblyExportBundle> {
  const [pieces, placed_slots, paired_fixtures] = await Promise.all([
    getAllPieces(),
    getAllPlacedSlots(),
    getAllPairedFixtures(),
  ])

  return {
    version: '1.0.0',
    exported_at: new Date().toISOString(),
    board_config: boardConfig,
    pieces,
    placed_slots,
    paired_fixtures,
  }
}

export async function importAssemblyDataset(bundle: AssemblyExportBundle): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pieces', 'board_slots', 'paired_fixtures'], 'readwrite')
    const pieceStore = tx.objectStore('pieces')
    const slotStore = tx.objectStore('board_slots')
    const pairStore = tx.objectStore('paired_fixtures')

    pieceStore.clear()
    slotStore.clear()
    pairStore.clear()

    for (const p of bundle.pieces || []) {
      pieceStore.put(p)
    }

    for (const [key, slot] of Object.entries(bundle.placed_slots || {})) {
      slotStore.put({ ...slot, slot_key: key })
    }

    for (const fix of bundle.paired_fixtures || []) {
      pairStore.put(fix)
    }

    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
