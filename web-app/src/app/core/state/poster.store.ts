import { Injectable, signal, computed, inject } from '@angular/core';
import {
  ClusteringStats,
  ClusteringWeights,
  PUZZLE_GRID,
  PosterSlotFeature,
  PosterViewMode,
  TrayId,
  TrayInfo
} from '../models/poster.model';
import {
  INITIAL_TRAYS,
  PosterClusteringService
} from '../services/poster-clustering.service';
import { WasmEngineService } from '../services/wasm-engine.service';
import { StorageService } from '../services/storage.service';
import { InventoryStore } from './inventory.store';

export const DEFAULT_CLUSTERING_WEIGHTS: ClusteringWeights = {
  wColor: 0.45,
  wTexture: 0.35,
  wSpatial: 0.20
};

// Calibrated representative Lab coordinates for the 8 default tray clusters
export const DEFAULT_FALLBACK_CENTROIDS: Record<number, [number, number, number]> = {
  1: [49.3, -42.8, 30.6],  // MEADOW (Green)
  2: [53.8, -10.9, -43.8], // SKY (Cyan/Blue)
  3: [44.8, 30.7, 54.3],   // BRICK (Orange/Amber)
  4: [50.4, 0.4, -6.9],    // STONE (Neutral Gray)
  5: [38.2, -37.8, 21.8],  // FOREST (Dark Green)
  6: [32.5, 34.3, 33.2],   // EARTH (Brown/Red)
  7: [44.6, -26.9, -4.5],  // CANOPY (Teal)
  8: [29.6, -1.9, -13.6]   // SHADOW (Dark Slate)
};

@Injectable({
  providedIn: 'root'
})
export class PosterStore {
  private readonly clusteringService = inject(PosterClusteringService);
  private readonly wasmEngine = inject(WasmEngineService);
  private readonly storageService = inject(StorageService);
  private readonly inventoryStore = inject(InventoryStore);

  readonly rows = PUZZLE_GRID.rows;
  readonly cols = PUZZLE_GRID.cols;
  readonly totalSlots = PUZZLE_GRID.totalSlots;
  readonly borderPieces = PUZZLE_GRID.borderPieces;
  readonly interiorPieces = PUZZLE_GRID.interiorPieces;

  // Dimension label helper e.g. "36×28"
  readonly dimensionLabel = `${this.cols}×${this.rows}`;

  // Warning threshold for tray fullness (e.g. 95% capacity)
  readonly trayWarnCapacity = 118;

  // Target fill marker percentage for visual gauges (~110.5 pcs / 125 cap)
  readonly targetFillPercent = 88.4;

  // Master poster canvas source (synthetic or uploaded)
  readonly posterCanvas = signal<HTMLCanvasElement | null>(null);

  // Slots & Trays
  readonly slots = signal<PosterSlotFeature[]>([]);
  readonly trays = signal<TrayInfo[]>(INITIAL_TRAYS);

  // Clustering weights
  readonly weights = signal<ClusteringWeights>({ ...DEFAULT_CLUSTERING_WEIGHTS });

  // Telemetry stats
  readonly stats = signal<ClusteringStats>({
    iterations: 0,
    maxIterations: 20,
    inertia: 0,
    isBalanced: true,
    overflowCount: 0,
    computeTimeMs: 0,
    totalPieces: 1008,
    borderPieces: 124,
    interiorPieces: 884
  });

  // UI state
  readonly selectedSlot = signal<PosterSlotFeature | null>(null);
  readonly hoveredSlot = signal<PosterSlotFeature | null>(null);
  readonly soloTrayId = signal<TrayId | null>(null);
  readonly viewMode = signal<PosterViewMode>('TINT');
  readonly showGrid = signal<boolean>(true);
  readonly isAnalyzing = signal<boolean>(false);

  // Computed tray lookup
  readonly trayMap = computed(() => {
    const map = new Map<TrayId, TrayInfo>();
    for (const tray of this.trays()) {
      map.set(tray.id, tray);
    }
    return map;
  });

  // Computed tray cluster centroids for piece routing
  readonly activeCentroids = computed(() => {
    const slots = this.slots();
    const centroids: Array<{
      lab: [number, number, number];
      gradient: number;
      color_std: number;
      r_norm: number;
      c_norm: number;
    }> = [];

    for (let trayId = 1; trayId <= 8; trayId++) {
      let sumL = 0;
      let sumA = 0;
      let sumB = 0;
      let sumGrad = 0;
      let sumStd = 0;
      let sumR = 0;
      let sumC = 0;
      let count = 0;

      for (const s of slots) {
        if (s.trayId === trayId) {
          sumL += s.lab[0];
          sumA += s.lab[1];
          sumB += s.lab[2];
          sumGrad += s.gradient;
          sumStd += s.colorStd ?? 0;
          sumR += Math.max(0, s.r - 1) / 25.0;
          sumC += Math.max(0, s.c - 1) / 33.0;
          count++;
        }
      }

      if (count > 0) {
        centroids.push({
          lab: [sumL / count, sumA / count, sumB / count],
          gradient: sumGrad / count,
          color_std: sumStd / count,
          r_norm: sumR / count,
          c_norm: sumC / count
        });
      } else {
        const fallbackLab = DEFAULT_FALLBACK_CENTROIDS[trayId] || [50, 0, 0];
        centroids.push({
          lab: fallbackLab,
          gradient: 0.15,
          color_std: 0.10,
          r_norm: 0.5,
          c_norm: 0.5
        });
      }
    }

    return centroids;
  });

  getTray(trayId: number): TrayInfo | undefined {
    return this.trayMap().get(trayId as TrayId);
  }

  constructor() {
    this.wasmEngine.initWasm().then(async () => {
      await this.initPosterFromStorageOrDefault();
    });
  }

  /**
   * Initializes poster from IndexedDB if previously calibrated, or falls back to default
   */
  async initPosterFromStorageOrDefault(): Promise<void> {
    try {
      const stored = await this.storageService.getPoster();
      if (stored && stored.slots && stored.slots.length > 0) {
        this.weights.set(stored.weights);
        this.slots.set(stored.slots);
        this.trays.set(stored.trays);
        this.stats.set(stored.stats);
        this.selectedSlot.set(stored.slots[0] || null);
        this.inventoryStore.syncFromPoster(stored.trays, stored.stats.borderPieces);

        if (stored.imageDataUrl) {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0);
              this.posterCanvas.set(canvas);
            }
          };
          img.src = stored.imageDataUrl;
        }
        return;
      }
    } catch (err) {
      console.warn('PosterStore: Failed to load stored poster, using defaults', err);
    }

    this.initDefaultPoster();
  }

  /**
   * Initializes default calibrated high-contrast puzzle poster artwork and weights
   */
  initDefaultPoster(): void {
    this.weights.set({ ...DEFAULT_CLUSTERING_WEIGHTS });
    const canvas = this.clusteringService.generateSyntheticPosterCanvas();
    this.posterCanvas.set(canvas);
    this.extractAndCluster(canvas);
  }

  /**
   * Loads an uploaded poster artwork file/image
   */
  loadPosterImage(img: HTMLImageElement): void {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);

    this.posterCanvas.set(canvas);
    this.extractAndCluster(canvas);
  }

  /**
   * Adjusts clustering weights and immediately re-clusters
   */
  setWeight(key: keyof ClusteringWeights, value: number): void {
    const normalized = Math.max(0.0, Math.min(1.0, Number(value.toFixed(2))));
    this.weights.update(w => ({ ...w, [key]: normalized }));
    this.recluster();
  }

  /**
   * Re-runs capacity-constrained K-means clustering
   */
  recluster(): void {
    const canvas = this.posterCanvas();
    if (!canvas) return;

    this.isAnalyzing.set(true);
    const result = this.clusteringService.clusterPoster(canvas, this.weights());
    if (result) {
      this.slots.set(result.slots);
      this.trays.set(result.trays);
      this.stats.set(result.stats);
      this.inventoryStore.syncFromPoster(result.trays, result.stats.borderPieces);
      this.syncSelectedSlot(result.slots);

      this.storageService.savePoster({
        id: 'current_poster',
        timestamp: Date.now(),
        weights: this.weights(),
        imageDataUrl: canvas.toDataURL('image/jpeg', 0.85),
        slots: result.slots,
        trays: result.trays,
        stats: result.stats
      }).catch(err => console.warn('PosterStore: Failed to persist re-clustered poster', err));
    }
    this.isAnalyzing.set(false);
  }

  private syncSelectedSlot(slots: PosterSlotFeature[]): void {
    const selected = this.selectedSlot();
    if (selected) {
      const match = slots.find(s => s.r === selected.r && s.c === selected.c);
      if (match) this.selectedSlot.set(match);
    }
  }

  setSoloTray(trayId: TrayId | null): void {
    this.soloTrayId.update(current => (current === trayId ? null : trayId));
  }

  setViewMode(mode: PosterViewMode): void {
    this.viewMode.set(mode);
  }

  toggleGrid(): void {
    this.showGrid.update(g => !g);
  }

  selectSlot(slot: PosterSlotFeature | null): void {
    this.selectedSlot.set(slot);
  }

  setHoveredSlot(slot: PosterSlotFeature | null): void {
    this.hoveredSlot.set(slot);
  }

  private extractAndCluster(canvas: HTMLCanvasElement): void {
    this.isAnalyzing.set(true);
    const result = this.clusteringService.clusterPoster(canvas, this.weights());
    if (result) {
      this.slots.set(result.slots);
      this.trays.set(result.trays);
      this.stats.set(result.stats);
      this.inventoryStore.syncFromPoster(result.trays, result.stats.borderPieces);
      this.selectedSlot.set(result.slots[0] || null);

      this.storageService.savePoster({
        id: 'current_poster',
        timestamp: Date.now(),
        weights: this.weights(),
        imageDataUrl: canvas.toDataURL('image/jpeg', 0.85),
        slots: result.slots,
        trays: result.trays,
        stats: result.stats
      }).catch(err => console.warn('PosterStore: Failed to persist extracted poster', err));
    }
    this.isAnalyzing.set(false);
  }
}
