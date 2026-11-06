use serde::{Deserialize, Serialize};
use crate::frontier::{EdgePolarity, SlotPolarityConstraint};

/// Represents a candidate piece that matched a slot's polarity constraints under a specific rotation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolarityMatch {
    pub piece_id: u32,
    /// Rotation index: 0 (0°), 1 (90° CW), 2 (180°), 3 (270° CW)
    pub rotation: u8,
    /// Piece's polarities rotated into world coordinates [North, East, South, West]
    pub world_polarities: [EdgePolarity; 4],
    /// Physical tab widths in mm rotated into world coordinates [North, East, South, West]
    pub world_tab_widths_mm: [f32; 4],
}

/// Lightweight piece descriptor passed into the candidate retrieval and pruning engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CandidatePieceInput {
    pub piece_id: u32,
    /// Intrinsic piece polarities at 0° scan orientation: [Top, Right, Bottom, Left]
    pub intrinsic_polarities: [EdgePolarity; 4],
    /// Corresponding tab widths in mm at 0° scan orientation
    pub tab_widths_mm: [f32; 4],
    pub is_border: bool,
    pub is_corner: bool,
}

/// Rotate 4 cardinal polarities clockwise by `rotation` * 90 degrees.
/// - 0 (0°):   [N, E, S, W] -> [N, E, S, W]
/// - 1 (90°):  [N, E, S, W] -> [W, N, E, S]
/// - 2 (180°): [N, E, S, W] -> [S, W, N, E]
/// - 3 (270°): [N, E, S, W] -> [E, S, W, N]
#[inline]
pub fn rotate_polarities(polarities: [EdgePolarity; 4], rotation: u8) -> [EdgePolarity; 4] {
    let r = (rotation % 4) as usize;
    [
        polarities[(4 - r) % 4],
        polarities[(4 + 1 - r) % 4],
        polarities[(4 + 2 - r) % 4],
        polarities[(4 + 3 - r) % 4],
    ]
}

/// Rotate 4 cardinal tab widths clockwise by `rotation` * 90 degrees.
#[inline]
pub fn rotate_tab_widths(widths: [f32; 4], rotation: u8) -> [f32; 4] {
    let r = (rotation % 4) as usize;
    [
        widths[(4 - r) % 4],
        widths[(4 + 1 - r) % 4],
        widths[(4 + 2 - r) % 4],
        widths[(4 + 3 - r) % 4],
    ]
}

/// Check if a rotated piece's world polarities satisfy a slot's polarity constraints.
/// Enforces topological invariants:
/// 1. An interior slot (0 required Flat edges) can NEVER accept a piece with any Flat edge.
/// 2. A border slot (1 required Flat edge) can ONLY accept a piece with exactly 1 Flat edge aligned to the border.
/// 3. A corner slot (2 required Flat edges) can ONLY accept a piece with exactly 2 Flat edges aligned to the corner.
/// 4. Every non-Any cardinal requirement must match exactly.
#[inline]
pub fn test_polarities_satisfy_constraint(
    world_polarities: &[EdgePolarity; 4],
    constraint: &SlotPolarityConstraint,
) -> bool {
    let targets = constraint.as_array();
    let slot_flat_count = constraint.flat_edge_count();

    // Invariant: count how many Flat edges this candidate piece has in world space
    let piece_flat_count = world_polarities
        .iter()
        .filter(|&&p| p == EdgePolarity::Flat)
        .count();

    // Piece flat edge count must match the slot's physical boundary requirement:
    // - Interior slot (slot_flat_count == 0): piece cannot have any flat edge
    // - Border slot (slot_flat_count == 1): piece must have exactly 1 flat edge
    // - Corner slot (slot_flat_count == 2): piece must have exactly 2 flat edges
    if piece_flat_count != slot_flat_count {
        return false;
    }

    for d in 0..4 {
        let req = targets[d];
        if req != EdgePolarity::Any && world_polarities[d] != req {
            return false;
        }
    }
    true
}

/// Find all valid rotations (0..=3) for a single piece that satisfy the slot constraint.
pub fn find_piece_valid_rotations(
    piece: &CandidatePieceInput,
    constraint: &SlotPolarityConstraint,
) -> Vec<PolarityMatch> {
    let mut matches = Vec::with_capacity(4);

    for rot in 0..4 {
        let world_polarities = rotate_polarities(piece.intrinsic_polarities, rot);
        if test_polarities_satisfy_constraint(&world_polarities, constraint) {
            let world_tab_widths_mm = rotate_tab_widths(piece.tab_widths_mm, rot);
            matches.push(PolarityMatch {
                piece_id: piece.piece_id,
                rotation: rot,
                world_polarities,
                world_tab_widths_mm,
            });
        }
    }

    matches
}

/// Batch prune a collection of candidate pieces against a slot's polarity constraints.
/// Evaluates all 4 cardinal rotations and returns valid `PolarityMatch` entries.
pub fn prune_candidates_by_polarity(
    candidates: &[CandidatePieceInput],
    constraint: &SlotPolarityConstraint,
) -> Vec<PolarityMatch> {
    let mut results = Vec::new();
    for candidate in candidates {
        let matches = find_piece_valid_rotations(candidate, constraint);
        results.extend(matches);
    }
    results
}

