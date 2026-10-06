export type EdgeType = 'Flat' | 'Tab' | 'Hole';
export type PieceClassification = 'Corner' | 'Border' | 'Interior';
export type PieceStatus = 'InTray' | 'Placed';

export interface Point2D {
  x: number;
  y: number;
}

export interface PieceEdge {
  edge_type: EdgeType;
  start_corner: Point2D;
  end_corner: Point2D;
  curvature_depth: number;
  curve_samples?: Point2D[];
  normalized_profile?: number[];
  fourier_descriptor?: number[];
  chord_length_mm?: number;
  tab_depth_mm?: number;
  tab_width_mm?: number;
  seam_rgb_samples?: [number, number, number][];
}

export interface PieceModel {
  id: string;
  piece_number: number;
  timestamp: number;
  thumbnailDataUrl: string;
  corners: [Point2D, Point2D, Point2D, Point2D];
  edges: [PieceEdge, PieceEdge, PieceEdge, PieceEdge];
  bounding_width_px: number;
  bounding_height_px: number;
  metric_width_mm: number;
  metric_height_mm: number;
  classification: PieceClassification;
  flat_count: number;
  tab_count: number;
  hole_count: number;
  status: PieceStatus;
  placed_slot: { row: number; col: number; rotation: number } | null;
  is_favorite: boolean;
  tags: string[];
  paired_piece_id: string | null;
}

export interface PlacedBoardSlot {
  slot_key: string;
  row: number;
  col: number;
  piece_id: string;
  rotation: number; // 0, 1, 2, 3 (0°, 90°, 180°, 270°)
  placed_at: number;
}

export interface BoardDimensions {
  rows: number;
  cols: number;
  total_slots: number;
}
