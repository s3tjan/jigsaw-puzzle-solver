import { Injectable, signal, computed, inject } from '@angular/core';
import {
  ClusteringStats,
  ClusteringWeights,
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

export const DEFAULT_CLUSTERING_WEIGHTS: ClusteringWeights = {
  wColor: 0.45,
  wTexture: 0.35,
  wSpatial: 0.20
};

@Injectable({
  providedIn: 'root'
})
export class PosterStore {
  private readonly clusteringService = inject(PosterClusteringService);
  private readonly wasmEngine = inject(WasmEngineService);

  readonly rows = 28;
  readonly cols = 36;
  readonly totalSlots = 28 * 36; // 1,008 total slots
  readonly borderPieces = 124;  // 4 corners + 34 top + 34 bottom + 26 left + 26 right
  readonly interiorPieces = 884; // 34 interior cols * 26 interior rows

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

  getTray(trayId: number): TrayInfo | undefined {
    return this.trayMap().get(trayId as TrayId);
  }

  constructor() {
    this.wasmEngine.initWasm().then(() => {
      this.initDefaultPoster();
    });
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
      this.syncSelectedSlot(result.slots);
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

  setShowGrid(show: boolean): void {
    this.showGrid.set(show);
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
      this.selectedSlot.set(result.slots[0] || null);
    }
    this.isAnalyzing.set(false);
  }
}
