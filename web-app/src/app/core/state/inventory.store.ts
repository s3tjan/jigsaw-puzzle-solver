import { Injectable, signal } from '@angular/core';
import { POLARITY_TRAYS, PolarityArchetype, classifyPolarityArchetype } from '../models/tray.model';

export interface TrayBucket extends PolarityArchetype {
  count: number;
}

@Injectable({
  providedIn: 'root'
})
export class InventoryStore {
  readonly trays = signal<TrayBucket[]>(
    POLARITY_TRAYS.map(t => ({ ...t, count: 0 }))
  );

  readonly totalIngested = signal<number>(0);
  readonly targetTotal = 1008;

  /**
   * Syncs tray piece counts from stored pieces in IndexedDB.
   */
  syncFromPieces(pieces: Array<{ trayId: number; polarities?: [string, string, string, string] }>): void {
    this.totalIngested.set(pieces.length);
    this.trays.update(trays => {
      return trays.map(t => {
        const count = pieces.filter(p => {
          // If piece has polarities, use the deterministic classifier
          if (p.polarities) {
            return classifyPolarityArchetype(p.polarities).id === t.id;
          }
          return p.trayId === t.id;
        }).length;
        return { ...t, count };
      });
    });
  }

  /**
   * Increments the count for an ingested piece's assigned tray.
   */
  incrementTray(trayId: number): void {
    this.totalIngested.update(c => c + 1);
    this.trays.update(trays =>
      trays.map(t => t.id === trayId ? { ...t, count: t.count + 1 } : t)
    );
  }

  /**
   * Decrements the count when a piece is deleted/retaken.
   */
  decrementTray(trayId: number): void {
    this.totalIngested.update(c => Math.max(0, c - 1));
    this.trays.update(trays =>
      trays.map(t => t.id === trayId ? { ...t, count: Math.max(0, t.count - 1) } : t)
    );
  }

  /**
   * Compatibility no-op for legacy poster sync callers.
   * Polarity trays are fixed mechanical categories and do not depend on poster color clusters.
   */
  syncFromPoster(_trays?: any, _borderCount?: number): void {
    // Intentionally no-op: Polarity archetype trays are independent of poster clusters.
  }

  getTray(trayId: number): TrayBucket | undefined {
    return this.trays().find(t => t.id === trayId);
  }
}
