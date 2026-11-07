import { Injectable, signal, computed, inject } from '@angular/core';
import { BoardSlot, CandidatePiece } from '../models/operator.model';
import { PUZZLE_GRID } from '../models/poster.model';
import { WasmEngineService, WasmFrontierSlot, WasmCandidatePieceInput, WasmPolarityMatch } from '../services/wasm-engine.service';
import { StorageService, StoredPiece } from '../services/storage.service';
import { InventoryStore } from './inventory.store';

@Injectable({
  providedIn: 'root'
})
export class BoardStore {
  private readonly wasm = inject(WasmEngineService);
  private readonly storage = inject(StorageService);
  private readonly inventory = inject(InventoryStore);

  readonly rows = PUZZLE_GRID.rows;
  readonly cols = PUZZLE_GRID.cols;
  readonly totalSlots = PUZZLE_GRID.totalSlots;
  readonly borderSlotsCount = PUZZLE_GRID.borderPieces;
  readonly interiorSlotsCount = PUZZLE_GRID.interiorPieces;

  // Native Rust WASM Board instance
  private wasmBoard: any = null;

  // Placed pieces mapping: key = `r,c` -> StoredPiece + rotation
  private readonly _placedPieces = signal<Map<string, { piece: StoredPiece; rotation: number }>>(new Map());
  readonly placedPieces = this._placedPieces.asReadonly();

  // Active frontier slots computed dynamically from Rust WASM
  private readonly _frontierSlots = signal<BoardSlot[]>([]);
  readonly frontierSlots = this._frontierSlots.asReadonly();

  // Selected slot for Spotting HUD
  private readonly _selectedSlot = signal<BoardSlot | null>(null);
  readonly selectedSlot = this._selectedSlot.asReadonly();

  // Top candidates matching active slot
  private readonly _candidates = signal<CandidatePiece[]>([]);
  readonly candidates = this._candidates.asReadonly();

  readonly placedCount = signal<number>(0);
  readonly frontierCount = computed(() => this._frontierSlots().length);

  constructor() {
    this.initBoard();
  }

  /**
   * Initializes or resets the Rust WASM BoardState instance and refreshes the frontier queue.
   */
  async initBoard(): Promise<void> {
    await this.wasm.initWasm();
    this.wasmBoard = this.wasm.createBoardState(this.rows, this.cols);
    this.refreshFrontier();
  }

  /**
   * Syncs the frontier queue directly from the Rust WASM engine.
   */
  refreshFrontier(): void {
    if (!this.wasmBoard) return;

    try {
      const rawJson = this.wasmBoard.get_active_frontier_json();
      const wasmFrontier: WasmFrontierSlot[] = JSON.parse(rawJson);

      const mapped: BoardSlot[] = wasmFrontier.map(f => ({
        r: f.r,
        c: f.c,
        isPlaced: false,
        placedNeighborCount: f.placed_neighbor_count,
        isBorder: f.is_border,
        isCorner: f.is_corner,
        expectedTabWidthsMm: f.expected_tab_widths_mm,
        requiredPolarities: {
          north: f.constraints.north,
          east: f.constraints.east,
          south: f.constraints.south,
          west: f.constraints.west,
        }
      }));

      this._frontierSlots.set(mapped);
      this.placedCount.set(this.wasmBoard.placed_count());

      // If no slot selected or selected slot is no longer in frontier, select the first
      const current = this._selectedSlot();
      if (!current || !mapped.some(s => s.r === current.r && s.c === current.c)) {
        if (mapped.length > 0) {
          this.selectSlot(mapped[0]);
        } else {
          this._selectedSlot.set(null);
          this._candidates.set([]);
        }
      }
    } catch (err) {
      console.error('BoardStore: failed to refresh frontier from WASM:', err);
    }
  }

  /**
   * Selects an active frontier slot and queries candidate pieces from IndexedDB.
   */
  async selectSlot(slot: BoardSlot): Promise<void> {
    this._selectedSlot.set(slot);
    await this.queryCandidatesForSlot(slot.r, slot.c);
  }

  /**
   * Queries the Rust WASM engine to prune all scanned pieces against slot (r, c) constraints.
   */
  async queryCandidatesForSlot(r: number, c: number): Promise<void> {
    if (!this.wasmBoard) return;

    try {
      const storedPieces = await this.storage.getAllPieces();
      if (!storedPieces || storedPieces.length === 0) {
        this._candidates.set([]);
        return;
      }

      // Convert stored pieces to WasmCandidatePieceInput
      const inputs: WasmCandidatePieceInput[] = storedPieces.map(p => {
        const flatCount = p.polarities.filter(pol => pol === 'FLAT').length;
        const width = p.tabWidthMm || 4.8;
        return {
          piece_id: p.id,
          intrinsic_polarities: p.polarities as any,
          tab_widths_mm: [
            p.polarities[0] === 'FLAT' ? 0.0 : width,
            p.polarities[1] === 'FLAT' ? 0.0 : width,
            p.polarities[2] === 'FLAT' ? 0.0 : width,
            p.polarities[3] === 'FLAT' ? 0.0 : width,
          ],
          is_border: flatCount >= 1,
          is_corner: flatCount >= 2,
        };
      });

      const matchesJson = this.wasmBoard.query_slot_polarity_candidates_json(r, c, JSON.stringify(inputs));
      const matches: WasmPolarityMatch[] = JSON.parse(matchesJson);

      const pieceMap = new Map<number, StoredPiece>();
      for (const p of storedPieces) {
        pieceMap.set(p.id, p);
      }

      const trays = this.inventory.trays();

      const candidateResults: CandidatePiece[] = matches.map(m => {
        const piece = pieceMap.get(m.piece_id);
        const trayId = piece ? piece.trayId : 0;
        const trayObj = trays.find(t => t.id === trayId);
        const trayName = trayObj ? trayObj.name : `TRAY ${trayId}`;

        const rotDeg = (m.rotation * 90) as (0 | 90 | 180 | 270);
        const rotLabel = this.formatRotationLabel(rotDeg);

        return {
          id: m.piece_id,
          trayId,
          trayName,
          confidence: piece ? piece.confidence : 0.90,
          rotation: rotDeg,
          rotationLabel: rotLabel,
          tabWidthMm: piece?.tabWidthMm || 4.8,
          thumbnailDataUrl: piece?.thumbnailDataUrl,
          archetypeBadge: trayObj?.shortLabel || `TRAY ${trayId}`,
        };
      });

      this._candidates.set(candidateResults);
    } catch (err) {
      console.error(`BoardStore: failed querying candidates for slot (${r}, ${c}):`, err);
      this._candidates.set([]);
    }
  }

  /**
   * Commits the top candidate piece to the currently selected slot.
   */
  async confirmPlacement(): Promise<void> {
    const current = this._selectedSlot();
    const candidate = this._candidates()[0];
    if (!current || !candidate || !this.wasmBoard) return;

    try {
      const stored = await this.storage.getPiece(candidate.id);
      if (!stored) return;

      const decodePolarityNumber = (pol: string) => {
        switch (pol) {
          case 'FLAT': return 0;
          case 'TAB': return 1;
          case 'HOLE': return 2;
          default: return 3;
        }
      };

      const rotIdx = (candidate.rotation / 90) as (0 | 1 | 2 | 3);
      const pols = stored.polarities;
      const width = stored.tabWidthMm || 4.8;

      this.wasmBoard.place_piece(
        current.r,
        current.c,
        candidate.id,
        rotIdx,
        decodePolarityNumber(pols[0]),
        decodePolarityNumber(pols[1]),
        decodePolarityNumber(pols[2]),
        decodePolarityNumber(pols[3]),
        pols[0] === 'FLAT' ? 0.0 : width,
        pols[1] === 'FLAT' ? 0.0 : width,
        pols[2] === 'FLAT' ? 0.0 : width,
        pols[3] === 'FLAT' ? 0.0 : width,
      );

      // Record in placed pieces map
      this._placedPieces.update(map => {
        const next = new Map(map);
        next.set(`${current.r},${current.c}`, { piece: stored, rotation: candidate.rotation });
        return next;
      });

      // Refresh dynamic frontier queue
      this.refreshFrontier();
    } catch (err) {
      console.error('BoardStore: error placing piece:', err);
    }
  }

  rejectCandidate(): void {
    this._candidates.update(list => {
      if (list.length <= 1) return list;
      return [...list.slice(1), list[0]];
    });
  }

  private formatRotationLabel(deg: 0 | 90 | 180 | 270): string {
    switch (deg) {
      case 0: return 'TAB UP (000°)';
      case 90: return 'TAB RIGHT (090°)';
      case 180: return 'TAB DOWN (180°)';
      case 270: return 'TAB LEFT (270°)';
    }
  }
}
