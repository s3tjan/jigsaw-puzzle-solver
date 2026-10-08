import { Injectable, signal, computed } from '@angular/core';
import { BoardSlot, CandidatePiece } from '../models/operator.model';
import { PUZZLE_GRID } from '../models/poster.model';

@Injectable({
  providedIn: 'root'
})
export class BoardStore {
  readonly rows = PUZZLE_GRID.rows;
  readonly cols = PUZZLE_GRID.cols;
  readonly totalSlots = PUZZLE_GRID.totalSlots;
  readonly borderSlotsCount = PUZZLE_GRID.borderPieces;
  readonly interiorSlotsCount = PUZZLE_GRID.interiorPieces;

  // Frontier queue
  private readonly _frontierSlots = signal<BoardSlot[]>([
    {
      r: 1, c: 1, isPlaced: false, entropy: 0.94,
      requiredPolarities: { north: 'FLAT', west: 'FLAT', east: 'TAB', south: 'HOLE' }
    },
    {
      r: 1, c: 2, isPlaced: false, entropy: 0.88,
      requiredPolarities: { north: 'FLAT', west: 'HOLE', east: 'HOLE', south: 'TAB' }
    },
    {
      r: 14, c: 8, isPlaced: false, entropy: 0.72,
      requiredPolarities: { north: 'TAB', west: 'HOLE', east: 'TAB', south: 'FLAT' }
    },
    {
      r: 14, c: 9, isPlaced: false, entropy: 0.65,
      requiredPolarities: { north: 'HOLE', west: 'HOLE', east: 'FLAT', south: 'TAB' }
    }
  ]);
  readonly frontierSlots = this._frontierSlots.asReadonly();

  // Selected slot for Spotting HUD
  private readonly _selectedSlot = signal<BoardSlot | null>(this._frontierSlots()[2]);
  readonly selectedSlot = this._selectedSlot.asReadonly();

  // Top candidates for active slot
  private readonly _candidates = signal<CandidatePiece[]>([
    {
      id: 342,
      trayId: 2,
      trayName: 'MEADOW',
      confidence: 0.942,
      rotation: 0,
      rotationLabel: 'TAB UP (000°)',
      tabWidthMm: 4.82
    },
    {
      id: 118,
      trayId: 2,
      trayName: 'MEADOW',
      confidence: 0.814,
      rotation: 90,
      rotationLabel: 'TAB RIGHT (090°)',
      tabWidthMm: 4.79
    },
    {
      id: 884,
      trayId: 4,
      trayName: 'FOREST',
      confidence: 0.731,
      rotation: 270,
      rotationLabel: 'TAB LEFT (270°)',
      tabWidthMm: 4.86
    }
  ]);
  readonly candidates = this._candidates.asReadonly();

  readonly placedCount = signal<number>(124); // 124 border pieces pre-anchored
  readonly frontierCount = computed(() => this._frontierSlots().length);

  selectSlot(slot: BoardSlot): void {
    this._selectedSlot.set(slot);
  }

  confirmPlacement(): void {
    const current = this._selectedSlot();
    if (!current) return;

    // Advance placement count and remove slot from frontier
    this.placedCount.update(c => c + 1);
    this._frontierSlots.update(slots => slots.filter(s => !(s.r === current.r && s.c === current.c)));
    const remaining = this._frontierSlots();
    this._selectedSlot.set(remaining.length > 0 ? remaining[0] : null);
  }

  rejectCandidate(): void {
    // Cycle candidates
    this._candidates.update(list => {
      if (list.length <= 1) return list;
      return [...list.slice(1), list[0]];
    });
  }
}
