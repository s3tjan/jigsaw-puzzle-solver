import { Injectable, signal, computed } from '@angular/core';
import { PieceModel, PieceStatus } from '../models/piece.model';
import { StorageService } from '../services/storage.service';

@Injectable({
  providedIn: 'root',
})
export class InventoryStore {
  readonly pieces = signal<PieceModel[]>([]);
  readonly selectedPieceId = signal<string | null>(null);

  readonly totalCount = computed(() => this.pieces().length);
  readonly placedCount = computed(() => this.pieces().filter(p => p.status === 'Placed').length);
  readonly inTrayCount = computed(() => this.pieces().filter(p => p.status === 'InTray').length);
  readonly selectedPiece = computed(() => {
    const id = this.selectedPieceId();
    return id ? this.pieces().find(p => p.id === id) ?? null : null;
  });

  constructor(private storage: StorageService) {
    this.loadInitial();
  }

  async loadInitial(): Promise<void> {
    const records = await this.storage.getAllPieces();
    this.pieces.set(records);
  }

  async addPiece(piece: PieceModel): Promise<void> {
    await this.storage.savePiece(piece);
    this.pieces.update(list => [piece, ...list]);
  }

  async removePiece(id: string): Promise<void> {
    await this.storage.deletePiece(id);
    this.pieces.update(list => list.filter(p => p.id !== id));
    if (this.selectedPieceId() === id) {
      this.selectedPieceId.set(null);
    }
  }

  selectPiece(id: string | null): void {
    this.selectedPieceId.set(id);
  }

  async updatePieceStatus(id: string, status: PieceStatus, placedSlot: { row: number; col: number; rotation: number } | null): Promise<void> {
    const target = this.pieces().find(p => p.id === id);
    if (!target) return;
    const updated: PieceModel = { ...target, status, placed_slot: placedSlot };
    await this.storage.savePiece(updated);
    this.pieces.update(list => list.map(p => p.id === id ? updated : p));
  }
}
