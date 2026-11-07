export type AppMode = 'POSTER' | 'OPTICS' | 'INGESTION' | 'WORKBENCH';

export interface BoardSlot {
  r: number;
  c: number;
  isPlaced: boolean;
  pieceId?: number;
  entropy?: number;
  placedNeighborCount?: number;
  isBorder?: boolean;
  isCorner?: boolean;
  expectedTabWidthsMm?: [number, number, number, number];
  requiredPolarities?: {
    north: 'TAB' | 'HOLE' | 'FLAT' | 'NONE' | 'ANY';
    east: 'TAB' | 'HOLE' | 'FLAT' | 'NONE' | 'ANY';
    south: 'TAB' | 'HOLE' | 'FLAT' | 'NONE' | 'ANY';
    west: 'TAB' | 'HOLE' | 'FLAT' | 'NONE' | 'ANY';
  };
}

export interface CandidatePiece {
  id: number;
  trayId: number;
  trayName: string;
  confidence: number;
  rotation: 0 | 90 | 180 | 270;
  rotationLabel: string;
  tabWidthMm: number;
  thumbnailDataUrl?: string;
  archetypeBadge?: string;
}
