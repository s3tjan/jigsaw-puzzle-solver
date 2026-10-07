import { Injectable, inject } from '@angular/core';
import {
  ClusteringResult,
  ClusteringWeights,
  TrayInfo
} from '../models/poster.model';
import { WasmEngineService } from './wasm-engine.service';

export const INITIAL_TRAYS: TrayInfo[] = [
  { id: 1, name: 'MEADOW',  tag: 'NW-1', color: '#15803d', count: 110, maxCapacity: 125, targetAvg: 110 },
  { id: 2, name: 'SKY',     tag: 'NC-2', color: '#0284c7', count: 110, maxCapacity: 125, targetAvg: 110 },
  { id: 3, name: 'BRICK',   tag: 'NE-3', color: '#b45309', count: 110, maxCapacity: 125, targetAvg: 110 },
  { id: 4, name: 'STONE',   tag: 'TR-4', color: '#6b7280', count: 110, maxCapacity: 125, targetAvg: 110 },
  { id: 5, name: 'FOREST',  tag: 'SW-5', color: '#166534', count: 110, maxCapacity: 125, targetAvg: 110 },
  { id: 6, name: 'EARTH',   tag: 'SC-6', color: '#7c2d12', count: 110, maxCapacity: 125, targetAvg: 110 },
  { id: 7, name: 'CANOPY',  tag: 'SE-7', color: '#0f766e', count: 110, maxCapacity: 125, targetAvg: 110 },
  { id: 8, name: 'SHADOW',  tag: 'BR-8', color: '#334155', count: 110, maxCapacity: 125, targetAvg: 110 }
];

@Injectable({
  providedIn: 'root'
})
export class PosterClusteringService {
  private readonly wasmEngine = inject(WasmEngineService);

  readonly rows = 28; // Total rows: 0..27 (2 border rows + 26 interior rows)
  readonly cols = 36; // Total cols: 0..35 (2 border cols + 34 interior cols)
  readonly totalSlots = 28 * 36; // 1,008 total slots
  readonly borderPieces = 124;  // 4 corners + 34 top + 34 bottom + 26 left + 26 right
  readonly interiorPieces = 884; // 34 interior cols * 26 interior rows

  /**
   * Primary entry point: Extracts features and clusters the poster canvas.
   * Delegates strictly and exclusively to the Rust WASM engine (`analyze_and_cluster_poster`).
   * No calculations, CIELAB conversions, or K-means clustering are performed in JavaScript.
   */
  clusterPoster(
    canvas: HTMLCanvasElement,
    weights: ClusteringWeights,
    maxCapacity: number = 125
  ): ClusteringResult | null {
    if (!this.wasmEngine.isReady()) {
      return null;
    }
    return this.wasmEngine.analyzeAndCluster(canvas, weights, maxCapacity);
  }

  /**
   * Generates a calibrated 1,008-piece puzzle poster pattern (36×28 grid)
   * with diverse color regions, sharp Sobel gradients, and textures for testing.
   */
  generateSyntheticPosterCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.cols * 40; // 36 * 40 = 1440px
    canvas.height = this.rows * 40; // 28 * 40 = 1120px
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    // Background gradient: Sky down to earth
    const bgGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bgGrad.addColorStop(0, '#38bdf8');   // Cyan Sky
    bgGrad.addColorStop(0.35, '#818cf8'); // Dusk Blue
    bgGrad.addColorStop(0.65, '#22c55e'); // Foliage Green
    bgGrad.addColorStop(1, '#78350f');   // Rich Soil
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Sun / high-contrast geometric disk (top right)
    ctx.fillStyle = '#fef08a';
    ctx.beginPath();
    ctx.arc(1100, 240, 150, 0, Math.PI * 2);
    ctx.fill();

    // Mountains / triangles with sharp Sobel gradient edges
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(160, 560);
    ctx.lineTo(480, 200);
    ctx.lineTo(800, 560);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(600, 600);
    ctx.lineTo(900, 260);
    ctx.lineTo(1200, 600);
    ctx.closePath();
    ctx.fill();

    // High texture forest patches (dots & hatching)
    ctx.fillStyle = '#14532d';
    for (let i = 0; i < 450; i++) {
      const x = 60 + ((i * 37) % 1320);
      const y = 600 + ((i * 29) % 380);
      ctx.fillRect(x, y, 6, 6);
    }

    // High-contrast brick structure (bottom left)
    ctx.fillStyle = '#b91c1c';
    ctx.fillRect(80, 800, 380, 240);
    ctx.fillStyle = '#fecaca';
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 8; c++) {
        ctx.fillRect(100 + c * 44, 820 + r * 34, 36, 20);
      }
    }

    return canvas;
  }
}
