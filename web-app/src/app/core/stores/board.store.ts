import { Injectable, signal, computed } from '@angular/core';
import { PlacedBoardSlot, BoardDimensions } from '../models/piece.model';
import { StorageService } from '../services/storage.service';

export const DEFAULT_BOARD_DIMENSIONS: BoardDimensions = {
  rows: 26,
  cols: 34,
  total_slots: 884, // 26 * 34 = 884 (or 28 * 36 = 1008 depending on die cut spec)
};

@Injectable({
  providedIn: 'root',
})
export class BoardStore {
  readonly dimensions = signal<BoardDimensions>({ rows: 28, cols: 36, total_slots: 1008 });
  readonly placedSlots = signal<Map<string, PlacedBoardSlot>>(new Map());
  readonly hoveredSlot = signal<{ row: number; col: number } | null>(null);

  readonly placedCount = computed(() => this.placedSlots().size);
  readonly occupancyRatio = computed(() => {
    const total = this.dimensions().total_slots;
    return total > 0 ? (this.placedSlots().size / total) * 100 : 0;
  });

  constructor(private storage: StorageService) {
    this.loadInitial();
  }

  async loadInitial(): Promise<void> {
    const records = await this.storage.getAllPlacedSlots();
    const map = new Map<string, PlacedBoardSlot>();
    for (const slot of records) {
      map.set(slot.slot_key, slot);
    }
    this.placedSlots.set(map);
  }

  async placePiece(row: number, col: number, pieceId: string, rotation: number): Promise<void> {
    const slotKey = `${row},${col}`;
    const record: PlacedBoardSlot = {
      slot_key: slotKey,
      row,
      col,
      piece_id: pieceId,
      rotation,
      placed_at: Date.now(),
    };
    await this.storage.savePlacedSlot(record);
    this.placedSlots.update(map => {
      const next = new Map(map);
      next.set(slotKey, record);
      return next;
    });
  }

  async removeSlot(row: number, col: number): Promise<void> {
    const slotKey = `${row},${col}`;
    await this.storage.removePlacedSlot(slotKey);
    this.placedSlots.update(map => {
      const next = new Map(map);
      next.delete(slotKey);
      return next;
    });
  }

  setHoveredSlot(row: number, col: number): void {
    this.hoveredSlot.set({ row, col });
  }

  clearHoveredSlot(): void {
    this.hoveredSlot.set(null);
  }
}
