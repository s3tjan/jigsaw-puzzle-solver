export type AppMode = 'POSTER' | 'OPTICS' | 'INGESTION' | 'WORKBENCH';

export interface BoardSlot {
  r: number;
  c: number;
  isPlaced: boolean;
  pieceId?: number;
  entropy?: number;
  requiredPolarities?: {
    north: 'TAB' | 'HOLE' | 'FLAT' | 'NONE';
    east: 'TAB' | 'HOLE' | 'FLAT' | 'NONE';
    south: 'TAB' | 'HOLE' | 'FLAT' | 'NONE';
    west: 'TAB' | 'HOLE' | 'FLAT' | 'NONE';
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
}
