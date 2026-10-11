import { Injectable, signal } from '@angular/core';

export interface TrayBucket {
  id: number;
  name: string;
  count: number;
  maxCapacity: number;
  color?: string;
}

@Injectable({
  providedIn: 'root'
})
export class InventoryStore {
  readonly maxTrayCapacity = 125;

  readonly trays = signal<TrayBucket[]>([
    { id: 0, name: 'BORDER & CORNERS', count: 0, maxCapacity: 124, color: '#111111' },
    { id: 1, name: 'MEADOW', count: 0, maxCapacity: 110, color: '#15803d' },
    { id: 2, name: 'SKY', count: 0, maxCapacity: 110, color: '#0284c7' },
    { id: 3, name: 'BRICK', count: 0, maxCapacity: 110, color: '#b45309' },
    { id: 4, name: 'STONE', count: 0, maxCapacity: 110, color: '#6b7280' },
    { id: 5, name: 'FOREST', count: 0, maxCapacity: 110, color: '#166534' },
    { id: 6, name: 'EARTH', count: 0, maxCapacity: 110, color: '#7c2d12' },
    { id: 7, name: 'CANOPY', count: 0, maxCapacity: 110, color: '#0f766e' },
    { id: 8, name: 'SHADOW', count: 0, maxCapacity: 110, color: '#334155' }
  ]);

  readonly totalIngested = signal<number>(0);
  readonly targetTotal = 1008;

  /**
   * Syncs tray counts and totalIngested from stored pieces
   */
  syncFromPieces(pieces: Array<{ trayId: number }>): void {
    this.totalIngested.set(pieces.length);
    this.trays.update(trays => {
      return trays.map(t => {
        const count = pieces.filter(p => p.trayId === t.id).length;
        return { ...t, count };
      });
    });
  }

  /**
   * Increments the count for an ingested piece's assigned tray (supports Tray 0..8)
   */
  incrementTray(trayId: number): void {
    this.totalIngested.update(c => c + 1);
    if (trayId >= 0) {
      this.trays.update(trays =>
        trays.map(t => t.id === trayId ? { ...t, count: t.count + 1 } : t)
      );
    }
  }

  /**
   * Decrements the count when a piece is deleted/retaken (supports Tray 0..8)
   */
  decrementTray(trayId: number): void {
    this.totalIngested.update(c => Math.max(0, c - 1));
    if (trayId >= 0) {
      this.trays.update(trays =>
        trays.map(t => t.id === trayId ? { ...t, count: Math.max(0, t.count - 1) } : t)
      );
    }
  }

  /**
   * Updates tray definitions and capacities from poster clustering results.
   * Sets maxCapacity for Trays 1-8 to the piece counts obtained from poster clustering (e.g. Forest: 90).
   * Sets Tray 0 maxCapacity to the border piece count (124).
   */
  syncFromPoster(posterTrays: Array<{ id: number; name: string; count: number; maxCapacity?: number; color?: string }>, borderCount: number = 124): void {
    this.trays.update(current => {
      return current.map(ct => {
        if (ct.id === 0) {
          return { ...ct, maxCapacity: borderCount || 124 };
        }
        const match = posterTrays.find(t => t.id === ct.id);
        if (match) {
          const cap = match.count > 0 ? match.count : (match.maxCapacity || 110);
          return { ...ct, name: match.name, color: match.color || ct.color, maxCapacity: cap };
        }
        return ct;
      });
    });
  }

  /**
   * Compatibility alias for syncFromPoster
   */
  setTraysFromPoster(trays: Array<{ id: number; name: string; count?: number; maxCapacity: number }>): void {
    this.syncFromPoster(trays as any);
  }
}
