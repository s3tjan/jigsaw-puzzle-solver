import { Injectable, signal } from '@angular/core';
import init, { analyze_and_cluster_poster } from '../../../pkg/cv_engine';
import {
  ClusteringResult,
  ClusteringStats,
  ClusteringWeights,
  PosterSlotFeature,
  TrayId,
  TrayInfo
} from '../models/poster.model';
import { INITIAL_TRAYS } from './poster-clustering.service';

interface RustSlotFeature {
  r: number;
  c: number;
  is_border: boolean;
  is_corner: boolean;
  lab: [number, number, number];
  gradient: number;
  color_std?: number;
  tray_id: number;
}

interface RustTrayInfo {
  id: number;
  name: string;
  color: string;
  count: number;
  max_capacity: number;
}

interface RustClusteringStats {
  iterations: number;
  max_iterations: number;
  inertia: number;
  is_balanced: boolean;
  overflow_count: number;
  compute_time_ms: number;
  total_pieces: number;
  border_pieces: number;
  interior_pieces: number;
}

interface RustClusteringResult {
  slots: RustSlotFeature[];
  trays: RustTrayInfo[];
  stats: RustClusteringStats;
}

@Injectable({
  providedIn: 'root'
})
export class WasmEngineService {
  private readonly _isReady = signal<boolean>(false);
  readonly isReady = this._isReady.asReadonly();
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.initWasm();
  }

  async initWasm(): Promise<void> {
    if (this._isReady()) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await init({ module_or_path: '/cv_engine_bg.wasm' });
        this._isReady.set(true);
      } catch (err) {
        console.warn('WasmEngineService: Failed to load /cv_engine_bg.wasm, using fallback', err);
      }
    })();

    return this.initPromise;
  }

  analyzeAndCluster(
    canvas: HTMLCanvasElement,
    weights: ClusteringWeights,
    maxCapacity: number = 125
  ): ClusteringResult | null {
    if (!this._isReady()) {
      return null;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgbaBuffer = new Uint8Array(imgData.data.buffer);

    try {
      const rawResult: RustClusteringResult = analyze_and_cluster_poster(
        rgbaBuffer,
        canvas.width,
        canvas.height,
        weights.wColor,
        weights.wTexture,
        weights.wSpatial,
        maxCapacity
      );

      return this.mapRustResult(rawResult);
    } catch (err) {
      console.error('WasmEngineService: analyze_and_cluster_poster failed:', err);
      return null;
    }
  }

  private mapRustResult(raw: RustClusteringResult): ClusteringResult {
    const slots: PosterSlotFeature[] = raw.slots.map(s => ({
      r: s.r,
      c: s.c,
      isBorder: s.is_border,
      isCorner: s.is_corner,
      lab: s.lab,
      rgb: this.labToRgb(s.lab),
      gradient: s.gradient,
      colorStd: s.color_std ?? 0.0,
      trayId: s.tray_id as TrayId | 0
    }));

    const trays: TrayInfo[] = raw.trays.map(t => {
      const fallback = INITIAL_TRAYS.find(it => it.id === t.id);
      return {
        id: t.id as TrayId,
        name: t.name,
        tag: fallback?.tag || `T-0${t.id}`,
        color: t.color,
        count: t.count,
        maxCapacity: t.max_capacity,
        targetAvg: fallback?.targetAvg || 110
      };
    });

    const stats: ClusteringStats = {
      iterations: raw.stats.iterations,
      maxIterations: raw.stats.max_iterations,
      inertia: raw.stats.inertia,
      isBalanced: raw.stats.is_balanced,
      overflowCount: raw.stats.overflow_count,
      computeTimeMs: raw.stats.compute_time_ms,
      totalPieces: raw.stats.total_pieces,
      borderPieces: raw.stats.border_pieces,
      interiorPieces: raw.stats.interior_pieces
    };

    return {
      slots,
      trays,
      stats
    };
  }

  private labToRgb(lab: [number, number, number]): [number, number, number] {
    const [L, a, b] = lab;
    const y = (L + 16.0) / 116.0;
    const x = a / 500.0 + y;
    const z = y - b / 200.0;

    const x3 = x * x * x;
    const z3 = z * z * z;

    const xr = x3 > 0.008856 ? x3 : (x - 16.0 / 116.0) / 7.787;
    const yr = L > 8.0 ? Math.pow((L + 16.0) / 116.0, 3) : L / 903.3;
    const zr = z3 > 0.008856 ? z3 : (z - 16.0 / 116.0) / 7.787;

    const X = xr * 0.95047;
    const Y = yr * 1.00000;
    const Z = zr * 1.08883;

    let rLin = X * 3.2406 + Y * -1.5372 + Z * -0.4986;
    let gLin = X * -0.9689 + Y * 1.8758 + Z * 0.0415;
    let bLin = X * 0.0557 + Y * -0.2040 + Z * 1.0570;

    const toSrgb = (c: number) => {
      const clamped = Math.max(0.0, Math.min(1.0, c));
      const val = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1.0 / 2.4) - 0.055;
      return Math.round(val * 255.0);
    };

    return [toSrgb(rLin), toSrgb(gLin), toSrgb(bLin)];
  }
}
