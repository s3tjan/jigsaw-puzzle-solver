import { Injectable } from '@angular/core';
import {
  ClusteringStats,
  ClusteringWeights,
  PosterSlotFeature,
  TrayId,
  TrayInfo
} from '../models/poster.model';

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

interface Centroid {
  lab: [number, number, number];
  gradient: number;
  rNorm: number;
  cNorm: number;
}

@Injectable({
  providedIn: 'root'
})
export class PosterClusteringService {
  readonly rows = 28; // Total rows: 0..27 (2 border rows + 26 interior rows)
  readonly cols = 36; // Total cols: 0..35 (2 border cols + 34 interior cols)
  readonly totalSlots = 28 * 36; // 1,008 total slots
  readonly borderPieces = 124;  // 4 corners + 34 top + 34 bottom + 26 left + 26 right
  readonly interiorPieces = 884; // 34 interior cols * 26 interior rows

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

  /**
   * TRY-01: Extract 1,008 feature vectors from canvas (124 border + 884 interior).
   */
  extractSlotFeatures(sourceCanvas: HTMLCanvasElement): PosterSlotFeature[] {
    const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];

    const imgWidth = sourceCanvas.width;
    const imgHeight = sourceCanvas.height;
    const imgData = ctx.getImageData(0, 0, imgWidth, imgHeight).data;

    const slotW = imgWidth / this.cols;
    const slotH = imgHeight / this.rows;

    const slots: PosterSlotFeature[] = [];

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const isBorder = (r === 0 || r === this.rows - 1 || c === 0 || c === this.cols - 1);
        const isCorner = isBorder && (
          (r === 0 && c === 0) ||
          (r === 0 && c === this.cols - 1) ||
          (r === this.rows - 1 && c === 0) ||
          (r === this.rows - 1 && c === this.cols - 1)
        );

        // Sample cell pixels
        const startX = Math.floor(c * slotW);
        const endX = Math.floor((c + 1) * slotW);
        const startY = Math.floor(r * slotH);
        const endY = Math.floor((r + 1) * slotH);

        let sumR = 0, sumG = 0, sumB = 0;
        let pixelCount = 0;
        let gradSum = 0;

        for (let y = startY; y < endY; y += 2) {
          for (let x = startX; x < endX; x += 2) {
            const idx = (y * imgWidth + x) * 4;
            const pr = imgData[idx];
            const pg = imgData[idx + 1];
            const pb = imgData[idx + 2];

            sumR += pr;
            sumG += pg;
            sumB += pb;
            pixelCount++;

            // Simple Sobel gradient approximation
            if (x + 2 < imgWidth && y + 2 < imgHeight) {
              const rightIdx = (y * imgWidth + (x + 2)) * 4;
              const downIdx = ((y + 2) * imgWidth + x) * 4;
              const dx = Math.abs(imgData[rightIdx] - pr);
              const dy = Math.abs(imgData[downIdx] - pr);
              gradSum += (dx + dy);
            }
          }
        }

        const meanR = pixelCount > 0 ? Math.round(sumR / pixelCount) : 128;
        const meanG = pixelCount > 0 ? Math.round(sumG / pixelCount) : 128;
        const meanB = pixelCount > 0 ? Math.round(sumB / pixelCount) : 128;

        const lab = this.rgbToLab(meanR, meanG, meanB);
        const normalizedGrad = Math.min(1.0, gradSum / (Math.max(1, pixelCount) * 128));

        // Border pieces are pre-anchored (trayId = 0)
        // Interior pieces are seeded to 8 physical trays (trayId = 1..8)
        const trayId: TrayId | 0 = isBorder ? 0 : this.getSpatialSeedTray(r, c);

        slots.push({
          r,
          c,
          rgb: [meanR, meanG, meanB],
          lab,
          gradient: normalizedGrad,
          trayId,
          isBorder,
          isCorner
        });
      }
    }

    return slots;
  }

  /**
   * TRY-04: Seed initial 8 centroids from a 2x4 spatial grid across the 34x26 interior.
   */
  private getSpatialSeedTray(r: number, c: number): TrayId {
    // Interior rows 1..26 (midpoint ~13)
    const rowBand = (r - 1) < 13 ? 0 : 1; // 0 (North) or 1 (South)
    // Interior cols 1..34 (4 bands of ~8.5 cols)
    const colBand = Math.min(3, Math.floor((c - 1) / (34.0 / 4))); // 0..3 (West to East)
    const id = (rowBand * 4 + colBand + 1) as TrayId;
    return id;
  }

  /**
   * TRY-02 & TRY-03: Weighted K-means clustering with capacity penalty.
   * Clusters the 884 interior slots into K=8 trays, capped at <= 125 pieces (~110 avg).
   */
  clusterSlots(
    allSlots: PosterSlotFeature[],
    weights: ClusteringWeights,
    maxIters = 20
  ): { slots: PosterSlotFeature[]; trays: TrayInfo[]; stats: ClusteringStats } {
    const startTime = performance.now();
    const k = 8;
    const maxCapacity = 125;
    const interiorSlots = allSlots.filter(s => !s.isBorder);
    const targetAvg = Math.round(interiorSlots.length / k); // 884 / 8 = 110.5 -> 111

    // 1. Initialize Centroids using 2x4 spatial seeds (TRY-04)
    const centroids: Centroid[] = [];
    for (let id = 1; id <= k; id++) {
      const seedSlots = interiorSlots.filter(s => this.getSpatialSeedTray(s.r, s.c) === id);
      if (seedSlots.length > 0) {
        let sumL = 0, sumA = 0, sumB = 0, sumG = 0, sumR = 0, sumC = 0;
        for (const s of seedSlots) {
          sumL += s.lab[0];
          sumA += s.lab[1];
          sumB += s.lab[2];
          sumG += s.gradient;
          sumR += (s.r - 1) / 26.0;
          sumC += (s.c - 1) / 34.0;
        }
        centroids.push({
          lab: [sumL / seedSlots.length, sumA / seedSlots.length, sumB / seedSlots.length],
          gradient: sumG / seedSlots.length,
          rNorm: sumR / seedSlots.length,
          cNorm: sumC / seedSlots.length
        });
      } else {
        centroids.push({
          lab: [50, 0, 0],
          gradient: 0.5,
          rNorm: 0.5,
          cNorm: 0.5
        });
      }
    }

    const assignments = new Uint8Array(interiorSlots.length);
    for (let i = 0; i < interiorSlots.length; i++) {
      assignments[i] = this.getSpatialSeedTray(interiorSlots[i].r, interiorSlots[i].c);
    }

    const trayCounts = new Int32Array(k + 1);
    let iterations = 0;
    let inertia = 0;

    // Normalization multipliers
    const wColor = weights.wColor;
    const wTexture = weights.wTexture;
    const wSpatial = weights.wSpatial;

    // 2. Iterative assignment with capacity penalty
    while (iterations < maxIters) {
      iterations++;
      let reassignments = 0;
      inertia = 0;

      // Count current cluster sizes
      trayCounts.fill(0);
      for (let i = 0; i < interiorSlots.length; i++) {
        trayCounts[assignments[i]]++;
      }

      for (let i = 0; i < interiorSlots.length; i++) {
        const slot = interiorSlots[i];
        const rNorm = (slot.r - 1) / 26.0;
        const cNorm = (slot.c - 1) / 34.0;

        let bestDist = Infinity;
        let bestTray = assignments[i];

        for (let t = 1; t <= k; t++) {
          const c = centroids[t - 1];

          // Normalized CIELAB Euclidean distance (L in 0..100, a,b in -128..127)
          const dL = (slot.lab[0] - c.lab[0]) / 100.0;
          const da = (slot.lab[1] - c.lab[1]) / 255.0;
          const db = (slot.lab[2] - c.lab[2]) / 255.0;
          const colorDist = Math.sqrt(dL * dL + da * da + db * db);

          // Texture distance
          const textureDist = Math.abs(slot.gradient - c.gradient);

          // Spatial distance
          const dR = rNorm - c.rNorm;
          const dC = cNorm - c.cNorm;
          const spatialDist = Math.sqrt(dR * dR + dC * dC);

          // Capacity penalty (TRY-03): linearly penalize clusters growing past targetAvg,
          // and heavily penalize approaching maxCapacity 125
          const currentCount = trayCounts[t];
          let capacityPenalty = 0;
          if (currentCount > targetAvg) {
            capacityPenalty += (currentCount - targetAvg) * 0.015;
          }
          if (currentCount >= maxCapacity) {
            capacityPenalty += 5.0; // Hard rejection barrier
          }

          const totalDist =
            (wColor * colorDist) +
            (wTexture * textureDist) +
            (wSpatial * spatialDist) +
            capacityPenalty;

          if (totalDist < bestDist) {
            bestDist = totalDist;
            bestTray = t as TrayId;
          }
        }

        inertia += bestDist;

        if (assignments[i] !== bestTray) {
          trayCounts[assignments[i]]--;
          trayCounts[bestTray]++;
          assignments[i] = bestTray;
          reassignments++;
        }
      }

      // Recompute centroids
      const sumL = new Float64Array(k + 1);
      const sumA = new Float64Array(k + 1);
      const sumB = new Float64Array(k + 1);
      const sumG = new Float64Array(k + 1);
      const sumR = new Float64Array(k + 1);
      const sumC = new Float64Array(k + 1);
      const counts = new Int32Array(k + 1);

      for (let i = 0; i < interiorSlots.length; i++) {
        const t = assignments[i];
        const s = interiorSlots[i];
        sumL[t] += s.lab[0];
        sumA[t] += s.lab[1];
        sumB[t] += s.lab[2];
        sumG[t] += s.gradient;
        sumR[t] += (s.r - 1) / 26.0;
        sumC[t] += (s.c - 1) / 34.0;
        counts[t]++;
      }

      for (let t = 1; t <= k; t++) {
        const count = counts[t];
        if (count > 0) {
          centroids[t - 1] = {
            lab: [sumL[t] / count, sumA[t] / count, sumB[t] / count],
            gradient: sumG[t] / count,
            rNorm: sumR[t] / count,
            cNorm: sumC[t] / count
          };
        }
      }

      // Early stop if converged
      if (reassignments < 3) {
        break;
      }
    }

    // Map assignments back to 1,008 total slots (124 border keep trayId: 0)
    let interiorIdx = 0;
    const updatedSlots: PosterSlotFeature[] = allSlots.map(s => {
      if (s.isBorder) {
        return { ...s, trayId: 0 as TrayId | 0 };
      }
      const assigned = assignments[interiorIdx++] as TrayId;
      return { ...s, trayId: assigned };
    });

    // Update tray statistics (8 trays summing to 884 interior pieces)
    let overflowCount = 0;
    const updatedTrays: TrayInfo[] = INITIAL_TRAYS.map(tray => {
      const count = trayCounts[tray.id];
      if (count > maxCapacity) overflowCount++;
      return {
        ...tray,
        count
      };
    });

    const computeTimeMs = Math.round(performance.now() - startTime);

    const stats: ClusteringStats = {
      iterations,
      maxIterations: maxIters,
      inertia: Number((inertia / interiorSlots.length).toFixed(4)),
      isBalanced: overflowCount === 0,
      overflowCount,
      computeTimeMs,
      totalPieces: this.totalSlots,
      borderPieces: this.borderPieces,
      interiorPieces: this.interiorPieces
    };

    return {
      slots: updatedSlots,
      trays: updatedTrays,
      stats
    };
  }

  /**
   * Convert sRGB [0..255] to CIELAB standard [L*, a*, b*]
   */
  private rgbToLab(r: number, g: number, b: number): [number, number, number] {
    // 1. Linearize RGB
    let lr = r / 255.0;
    let lg = g / 255.0;
    let lb = b / 255.0;

    lr = lr > 0.04045 ? Math.pow((lr + 0.055) / 1.055, 2.4) : lr / 12.92;
    lg = lg > 0.04045 ? Math.pow((lg + 0.055) / 1.055, 2.4) : lg / 12.92;
    lb = lb > 0.04045 ? Math.pow((lb + 0.055) / 1.055, 2.4) : lb / 12.92;

    // 2. Observer = 2°, Illuminant = D65 to XYZ
    let x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
    let y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722) / 1.00000;
    let z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;

    // 3. XYZ to LAB
    x = x > 0.008856 ? Math.cbrt(x) : (7.787 * x) + (16.0 / 116.0);
    y = y > 0.008856 ? Math.cbrt(y) : (7.787 * y) + (16.0 / 116.0);
    z = z > 0.008856 ? Math.cbrt(z) : (7.787 * z) + (16.0 / 116.0);

    const L = (116.0 * y) - 16.0;
    const a = 500.0 * (x - y);
    const bLab = 200.0 * (y - z);

    return [L, a, bLab];
  }
}
