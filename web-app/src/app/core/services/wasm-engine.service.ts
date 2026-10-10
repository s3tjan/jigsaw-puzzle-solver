import { Injectable, signal } from '@angular/core';
import init, {
  analyze_and_cluster_poster,
  ingest_mat_piece,
  snap_fiducial_corner,
  dewarp_quad,
  measure_stage_focus
} from '../../../pkg/cv_engine';
import {
  ClusteringResult,
  ClusteringStats,
  ClusteringWeights,
  PosterSlotFeature,
  TrayId,
  TrayInfo
} from '../models/poster.model';
import { INITIAL_TRAYS } from './poster-clustering.service';

export interface IngestedPiecePayload {
  success: boolean;
  polarities: [string, string, string, string];
  tabWidthMm: number;
  confidence: number;
  trayId: number;
  isBorder: boolean;
  isCorner: boolean;
  meanLab: [number, number, number];
  contourPoints: number[];
  corners: number[];
  normalizedProfiles: number[][];
  error?: string;
}

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

  snapFiducialCorner(
    rgbaBuffer: Uint8Array,
    width: number,
    height: number,
    seedX: number,
    seedY: number,
    radius: number = 32
  ): [number, number] | null {
    if (!this._isReady()) return null;
    try {
      const res = snap_fiducial_corner(rgbaBuffer, width, height, seedX, seedY, radius);
      if (res && res.length >= 2) {
        return [res[0], res[1]];
      }
      return null;
    } catch {
      return null;
    }
  }

  dewarpQuad(
    rgbaBuffer: Uint8Array,
    width: number,
    height: number,
    corners: [number, number, number, number, number, number, number, number],
    dstW: number = 384,
    dstH: number = 384,
    k1: number = 0.0
  ): Uint8Array | null {
    if (!this._isReady()) return null;
    try {
      return dewarp_quad(
        rgbaBuffer,
        width,
        height,
        corners[0], corners[1],
        corners[2], corners[3],
        corners[4], corners[5],
        corners[6], corners[7],
        dstW,
        dstH,
        k1
      );
    } catch (err) {
      console.error('WasmEngineService: dewarp_quad failed:', err);
      return null;
    }
  }

  measureStageFocus(
    rgbaBuffer: Uint8Array,
    width: number,
    height: number,
    corners: [number, number, number, number, number, number, number, number]
  ): number {
    if (!this._isReady()) return 0;
    try {
      return measure_stage_focus(
        rgbaBuffer,
        width,
        height,
        corners[0], corners[1],
        corners[2], corners[3],
        corners[4], corners[5],
        corners[6], corners[7]
      );
    } catch {
      return 0;
    }
  }

  ingestMatPiece(
    canvas: HTMLCanvasElement,
    corners: [number, number, number, number, number, number, number, number],
    centroids: Array<{ lab: [number, number, number]; gradient: number; color_std: number; r_norm: number; c_norm: number }>,
    weights: { wColor: number; wTexture: number } = { wColor: 0.7, wTexture: 0.2 },
    sensitivity: number = 25.0,
    k1: number = 0.0
  ): IngestedPiecePayload | null {
    if (!this._isReady()) {
      return null;
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgbaBuffer = new Uint8Array(imgData.data.buffer);
    const centroidsJson = JSON.stringify(centroids);

    try {
      const raw = ingest_mat_piece(
        rgbaBuffer,
        canvas.width,
        canvas.height,
        corners[0], corners[1],
        corners[2], corners[3],
        corners[4], corners[5],
        corners[6], corners[7],
        384, // dst_w (96mm at 96px = 25mm)
        384, // dst_h
        k1,  // lens distortion
        sensitivity,
        centroidsJson,
        weights.wColor,
        weights.wTexture
      );

      return {
        success: Boolean(raw.success),
        polarities: raw.polarities,
        tabWidthMm: raw.tab_width_mm,
        confidence: raw.confidence,
        trayId: raw.tray_id,
        isBorder: Boolean(raw.is_border),
        isCorner: Boolean(raw.is_corner),
        meanLab: raw.mean_lab,
        contourPoints: raw.contour_points || [],
        corners: raw.corners || [],
        normalizedProfiles: raw.normalized_profiles || [],
        error: raw.error
      };
    } catch (err) {
      console.error('WasmEngineService: ingest_mat_piece failed:', err);
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
