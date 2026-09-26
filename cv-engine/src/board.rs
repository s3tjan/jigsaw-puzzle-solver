use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use crate::contour::{ScannedPiece, PieceEdge, EdgeType};
use crate::mating::match_edge_curves;

/// Orientation/rotation of a piece placed in a grid cell (in 90-degree steps clockwise)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RotationStep {
    Rot0 = 0,   // Original orientation: Edge 0=North, 1=East, 2=South, 3=West
    Rot90 = 1,  // Rotated 90° CW:     Edge 3=North, 0=East, 1=South, 2=West
    Rot180 = 2, // Rotated 180° CW:    Edge 2=North, 3=East, 0=South, 1=West
    Rot270 = 3, // Rotated 270° CW:    Edge 1=North, 2=East, 3=South, 0=West
}

impl RotationStep {
    /// Returns the original piece edge index mapped to the specified cardinal direction
    /// cardinal: 0 = North, 1 = East, 2 = South, 3 = West
    pub fn get_piece_edge_idx(self, cardinal: usize) -> usize {
        let rot = self as usize;
        (cardinal + 4 - rot) % 4
    }

    pub fn from_u8(val: u8) -> Self {
        match val % 4 {
            0 => RotationStep::Rot0,
            1 => RotationStep::Rot90,
            2 => RotationStep::Rot180,
            _ => RotationStep::Rot270,
        }
    }
}

/// A cell on the puzzle assembly board grid
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardSlot {
    pub row: usize,
    pub col: usize,
    /// If placed, the ID of the scanned piece occupying this cell
    pub piece_id: Option<usize>,
    /// Rotation of the placed piece
    pub rotation: Option<RotationStep>,
    /// Candidate pieces and fit scores for this slot
    pub is_border: bool,
    pub is_corner: bool,
}

/// Candidate match candidate ranking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotCandidate {
    pub row: usize,
    pub col: usize,
    pub rotation: RotationStep,
    pub score: f32,
    pub reason: String,
}

/// The stateful 2D grid graph representing the puzzle assembly board
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PuzzleBoard {
    pub rows: usize,
    pub cols: usize,
    pub slots: Vec<BoardSlot>,
    pub placed_pieces: Vec<Option<ScannedPiece>>,
}

impl PuzzleBoard {
    pub fn new(rows: usize, cols: usize) -> Self {
        let mut slots = Vec::with_capacity(rows * cols);
        for r in 0..rows {
            for c in 0..cols {
                let is_top = r == 0;
                let is_bottom = r == rows - 1;
                let is_left = c == 0;
                let is_right = c == cols - 1;

                let is_corner = (is_top || is_bottom) && (is_left || is_right);
                let is_border = is_top || is_bottom || is_left || is_right;

                slots.push(BoardSlot {
                    row: r,
                    col: c,
                    piece_id: None,
                    rotation: None,
                    is_border,
                    is_corner,
                });
            }
        }

        PuzzleBoard {
            rows,
            cols,
            slots,
            placed_pieces: Vec::new(),
        }
    }

    pub fn slot_index(&self, row: usize, col: usize) -> usize {
        row * self.cols + col
    }

    /// Place a scanned piece on the board at (row, col) with specified rotation
    pub fn place_piece(&mut self, piece_id: usize, piece: ScannedPiece, row: usize, col: usize, rotation: RotationStep) -> Result<(), String> {
        if row >= self.rows || col >= self.cols {
            return Err("Cell coordinates out of bounds".to_string());
        }

        let idx = self.slot_index(row, col);

        // Ensure placed_pieces is large enough
        if self.placed_pieces.len() <= piece_id {
            self.placed_pieces.resize(piece_id + 1, None);
        }
        self.placed_pieces[piece_id] = Some(piece);

        self.slots[idx].piece_id = Some(piece_id);
        self.slots[idx].rotation = Some(rotation);

        Ok(())
    }

    /// Remove a piece from the board
    pub fn unplace_piece(&mut self, row: usize, col: usize) {
        if row < self.rows && col < self.cols {
            let idx = self.slot_index(row, col);
            self.slots[idx].piece_id = None;
            self.slots[idx].rotation = None;
        }
    }

    /// Get edge of a placed piece facing a cardinal direction (0=North, 1=East, 2=South, 3=West)
    pub fn get_neighbor_facing_edge(&self, row: usize, col: usize, cardinal: usize) -> Option<&PieceEdge> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        let slot = &self.slots[self.slot_index(row, col)];
        let piece_id = slot.piece_id?;
        let rotation = slot.rotation?;
        let piece = self.placed_pieces.get(piece_id)?.as_ref()?;

        let edge_idx = rotation.get_piece_edge_idx(cardinal);
        piece.edges.get(edge_idx)
    }

    /// Searches the entire grid and prunes candidate slots for a newly scanned piece
    pub fn find_candidate_slots(&self, piece: &ScannedPiece) -> Vec<SlotCandidate> {
        let mut candidates = Vec::new();

        if piece.edges.len() != 4 {
            return candidates;
        }

        // 1. Structural topological pruning:
        // - Corner pieces (2 Flat edges) can ONLY go into 4 corner slots
        // - Border pieces (1 Flat edge) can ONLY go into border non-corner slots
        // - Interior pieces (0 Flat edges) can ONLY go into interior slots
        let flat_count = piece.edges.iter().filter(|e| e.edge_type == EdgeType::Flat).count();

        for r in 0..self.rows {
            for c in 0..self.cols {
                let slot_idx = self.slot_index(r, c);
                if slot_idx >= self.slots.len() {
                    continue;
                }
                let slot = &self.slots[slot_idx];
                // If slot already occupied, skip
                if slot.piece_id.is_some() {
                    continue;
                }

                // Prune by topology
                if slot.is_corner && flat_count != 2 {
                    continue;
                }
                if slot.is_border && !slot.is_corner && flat_count != 1 {
                    continue;
                }
                if !slot.is_border && flat_count != 0 {
                    continue;
                }

                // Test all 4 rotations (0, 90, 180, 270)
                for rot_val in 0..4u8 {
                    let rot = RotationStep::from_u8(rot_val);

                    let n_edge_idx = rot.get_piece_edge_idx(0);
                    let e_edge_idx = rot.get_piece_edge_idx(1);
                    let s_edge_idx = rot.get_piece_edge_idx(2);
                    let w_edge_idx = rot.get_piece_edge_idx(3);

                    if n_edge_idx >= piece.edges.len()
                        || e_edge_idx >= piece.edges.len()
                        || s_edge_idx >= piece.edges.len()
                        || w_edge_idx >= piece.edges.len()
                    {
                        continue;
                    }

                    let n_type = piece.edges[n_edge_idx].edge_type;
                    let e_type = piece.edges[e_edge_idx].edge_type;
                    let s_type = piece.edges[s_edge_idx].edge_type;
                    let w_type = piece.edges[w_edge_idx].edge_type;

                    if (r == 0 && n_type != EdgeType::Flat) || (r > 0 && n_type == EdgeType::Flat) {
                        continue;
                    }
                    if (c == self.cols.saturating_sub(1) && e_type != EdgeType::Flat) || (c < self.cols.saturating_sub(1) && e_type == EdgeType::Flat) {
                        continue;
                    }
                    if (r == self.rows.saturating_sub(1) && s_type != EdgeType::Flat) || (r < self.rows.saturating_sub(1) && s_type == EdgeType::Flat) {
                        continue;
                    }
                    if (c == 0 && w_type != EdgeType::Flat) || (c > 0 && w_type == EdgeType::Flat) {
                        continue;
                    }

                    // Check neighbor matches if any neighbor is already placed
                    let mut neighbor_count = 0;
                    let mut total_score = 0.0f32;
                    let mut mismatch = false;

                    // North neighbor (r - 1, c) facing South (cardinal 2)
                    if r > 0 {
                        if let Some(neighbor_edge) = self.get_neighbor_facing_edge(r - 1, c, 2) {
                            let piece_edge = &piece.edges[n_edge_idx];
                            let score = match_edge_curves(piece_edge, neighbor_edge);
                            if score < 0.15 {
                                mismatch = true;
                            } else {
                                neighbor_count += 1;
                                total_score += score;
                            }
                        }
                    }

                    // East neighbor (r, c + 1) facing West (cardinal 3)
                    if !mismatch && c + 1 < self.cols {
                        if let Some(neighbor_edge) = self.get_neighbor_facing_edge(r, c + 1, 3) {
                            let piece_edge = &piece.edges[e_edge_idx];
                            let score = match_edge_curves(piece_edge, neighbor_edge);
                            if score < 0.15 {
                                mismatch = true;
                            } else {
                                neighbor_count += 1;
                                total_score += score;
                            }
                        }
                    }

                    // South neighbor (r + 1, c) facing North (cardinal 0)
                    if !mismatch && r + 1 < self.rows {
                        if let Some(neighbor_edge) = self.get_neighbor_facing_edge(r + 1, c, 0) {
                            let piece_edge = &piece.edges[s_edge_idx];
                            let score = match_edge_curves(piece_edge, neighbor_edge);
                            if score < 0.15 {
                                mismatch = true;
                            } else {
                                neighbor_count += 1;
                                total_score += score;
                            }
                        }
                    }

                    // West neighbor (r, c - 1) facing East (cardinal 1)
                    if !mismatch && c > 0 {
                        if let Some(neighbor_edge) = self.get_neighbor_facing_edge(r, c - 1, 1) {
                            let piece_edge = &piece.edges[w_edge_idx];
                            let score = match_edge_curves(piece_edge, neighbor_edge);
                            if score < 0.15 {
                                mismatch = true;
                            } else {
                                neighbor_count += 1;
                                total_score += score;
                            }
                        }
                    }

                    if mismatch {
                        continue;
                    }

                    let final_score = if neighbor_count > 0 {
                        total_score / neighbor_count as f32
                    } else if slot.is_corner {
                        0.95
                    } else if slot.is_border {
                        0.75
                    } else {
                        0.50
                    };

                    let reason = if neighbor_count > 0 {
                        format!("Locked to {} neighbor edge(s) ({:.0}% fit)", neighbor_count, final_score * 100.0)
                    } else if slot.is_corner {
                        "Corner alignment match".to_string()
                    } else if slot.is_border {
                        "Border perimeter alignment".to_string()
                    } else {
                        "Grid boundary compatible".to_string()
                    };

                    candidates.push(SlotCandidate {
                        row: r,
                        col: c,
                        rotation: rot,
                        score: if final_score.is_nan() { 0.0 } else { final_score },
                        reason,
                    });
                }
            }
        }

        // Sort descending by match score safely
        candidates.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(15);
        candidates
    }
}

// -------------------------------------------------------------
// WASM Export Wrapper
// -------------------------------------------------------------

#[wasm_bindgen]
pub struct WasmPuzzleBoard {
    inner: PuzzleBoard,
}

#[wasm_bindgen]
impl WasmPuzzleBoard {
    #[wasm_bindgen(constructor)]
    pub fn new(rows: usize, cols: usize) -> Self {
        WasmPuzzleBoard {
            inner: PuzzleBoard::new(rows, cols),
        }
    }

    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> usize {
        self.inner.rows
    }

    #[wasm_bindgen(getter)]
    pub fn cols(&self) -> usize {
        self.inner.cols
    }

    /// Returns JSON serialized representation of board slots
    pub fn get_slots_json(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.slots)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Place a piece on the board
    pub fn place_piece(
        &mut self,
        piece_id: usize,
        piece_js: JsValue,
        row: usize,
        col: usize,
        rotation_step: u8,
    ) -> Result<bool, JsValue> {
        let piece: ScannedPiece = serde_wasm_bindgen::from_value(piece_js)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let rot = RotationStep::from_u8(rotation_step);
        self.inner.place_piece(piece_id, piece, row, col, rot)
            .map(|_| true)
            .map_err(|e| JsValue::from_str(&e))
    }

    /// Unplace a piece
    pub fn unplace_piece(&mut self, row: usize, col: usize) {
        self.inner.unplace_piece(row, col);
    }

    /// Find best matching candidate slots for a piece
    pub fn find_candidates(&self, piece_js: JsValue) -> Result<JsValue, JsValue> {
        let piece: ScannedPiece = match serde_wasm_bindgen::from_value(piece_js) {
            Ok(p) => p,
            Err(e) => return Err(JsValue::from_str(&e.to_string())),
        };
        let candidates = self.inner.find_candidate_slots(&piece);
        serde_wasm_bindgen::to_value(&candidates)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
