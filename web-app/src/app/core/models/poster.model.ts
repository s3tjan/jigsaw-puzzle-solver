export type TrayId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface TrayInfo {
  id: TrayId;
  name: string;
  tag: string;
  color: string;
  count: number;
  maxCapacity: number; // 125 pcs hard cap
  targetAvg: number;   // ~110 pcs avg
}

export interface ClusteringWeights {
  wColor: number;   // Default 0.45
  wTexture: number; // Default 0.35
  wSpatial: number; // Default 0.20
}

export interface PosterSlotFeature {
  r: number; // 0..27 (28 total rows)
  c: number; // 0..35 (36 total cols)
  rgb: [number, number, number];
  lab: [number, number, number];
  gradient: number; // Normalized 0.0 .. 1.0 Sobel magnitude
  trayId: TrayId | 0; // 1..8 for interior pieces, 0 for perimeter border pieces
  isBorder: boolean;  // 124 perimeter slots
  isCorner: boolean;  // 4 corners
}

export type PosterViewMode = 'TINT' | 'RAW' | 'GRADIENT';

export interface ClusteringStats {
  iterations: number;
  maxIterations: number;
  inertia: number;
  isBalanced: boolean;
  overflowCount: number;
  computeTimeMs: number;
  totalPieces: number;    // 1,008
  borderPieces: number;   // 124
  interiorPieces: number; // 884
}

export interface ClusteringResult {
  slots: PosterSlotFeature[];
  trays: TrayInfo[];
  stats: ClusteringStats;
}

