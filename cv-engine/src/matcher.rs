use crate::contour::{EdgeType, PieceEdge, ScannedPiece};
use crate::homography::Point2D;
use wasm_bindgen::prelude::*;

/// Result of evaluating pairwise compatibility between two piece edges
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PairwiseMatchResult {
    pub is_compatible: bool,
    pub l2_distance: f32,          // Normalized L2 curve residual [0.0, 1.0]
    pub alignment_offset: i32,     // Best sliding window shift (-2..=2 samples)
    pub confidence: f32,           // Compatibility confidence [0.0, 100.0]%
    pub rejection_reason: Option<String>,
}

/// A candidate edge match found in the inventory
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct EdgeMatingCandidate {
    pub piece_index: usize,
    pub edge_index: usize,         // 0: Top, 1: Right, 2: Bottom, 3: Left
    pub edge_type: EdgeType,
    pub l2_distance: f32,
    pub alignment_offset: i32,
    pub confidence: f32,
}

/// Compute arc-length turn-angles theta(s) for a sequence of 2D curve points
/// Returns an invariant representation of intrinsic boundary curvature
pub fn compute_turn_angles(points: &[Point2D]) -> Vec<f32> {
    if points.len() < 3 {
        return Vec::new();
    }

    let mut angles = Vec::with_capacity(points.len() - 2);
    for i in 1..points.len() - 1 {
        let prev = points[i - 1];
        let curr = points[i];
        let next = points[i + 1];

        let v1_x = curr.x - prev.x;
        let v1_y = curr.y - prev.y;
        let v2_x = next.x - curr.x;
        let v2_y = next.y - curr.y;

        let a1 = v1_y.atan2(v1_x);
        let a2 = v2_y.atan2(v2_x);

        let mut diff = a2 - a1;
        while diff > std::f32::consts::PI {
            diff -= 2.0 * std::f32::consts::PI;
        }
        while diff < -std::f32::consts::PI {
            diff += 2.0 * std::f32::consts::PI;
        }
        angles.push(diff);
    }
    angles
}

/// Fast rejection filter checking topological and geometric compatibility
/// Returns None if edges pass the fast filter, or Some(rejection_reason) if rejected.
pub fn fast_rejection_filter(
    type_a: EdgeType,
    depth_a: f32,
    type_b: EdgeType,
    depth_b: f32,
) -> Option<String> {
    // 1. Edge Type Rule:
    // Tab can ONLY mate with Hole, and Hole can ONLY mate with Tab.
    // Flat can only mate with Flat (outer frame alignment).
    match (type_a, type_b) {
        (EdgeType::Tab, EdgeType::Hole) | (EdgeType::Hole, EdgeType::Tab) => {
            // Morphologically compatible interlock
        }
        (EdgeType::Flat, EdgeType::Flat) => {
            // Both flat outer boundary edges
        }
        (EdgeType::Tab, EdgeType::Tab) => {
            return Some("Rejection: Tab-Tab collision (two male protrusions cannot interlock)".to_string());
        }
        (EdgeType::Hole, EdgeType::Hole) => {
            return Some("Rejection: Hole-Hole void (two female indentations leave an empty gap)".to_string());
        }
        (EdgeType::Flat, _) | (_, EdgeType::Flat) => {
            return Some("Rejection: Flat edge cannot mate with non-flat interlocking feature".to_string());
        }
    }

    // 2. Relative Protrusion / Indentation Depth Consistency
    // In a physical die cut, the height of the male tab must closely match the depth of the female hole.
    let abs_da = depth_a.abs();
    let abs_db = depth_b.abs();
    let max_d = abs_da.max(abs_db);

    if max_d > 0.05 {
        let depth_delta = (abs_da - abs_db).abs();
        let depth_ratio = depth_delta / max_d;
        if depth_ratio > 0.55 {
            return Some(format!(
                "Rejection: Incompatible tab/hole depth (depth_a={:.3}, depth_b={:.3}, ratio={:.1}%)",
                abs_da, abs_db, depth_ratio * 100.0
            ));
        }
    }

    None
}

/// Compute Euclidean L2 curve difference between complementary 100-sample profiles
/// with a sliding alignment window of [-max_shift, +max_shift] to tolerate corner jitter.
///
/// Returns (best_l2_distance, best_shift_offset).
pub fn compute_complementary_l2_distance(
    profile_a: &[f32],
    profile_b: &[f32],
    max_shift: i32,
) -> (f32, i32) {
    let n = profile_a.len().min(profile_b.len());
    if n < 10 {
        return (1.0, 0);
    }

    let mut best_l2 = f32::MAX;
    let mut best_shift = 0;

    for shift in -max_shift..=max_shift {
        let mut sum_sq = 0.0f32;
        let mut count = 0usize;

        for k in 0..n {
            // Profile B is traversed in reverse (from n - 1 down to 0) along the common seam.
            let b_target_idx = (n as i32 - 1) - (k as i32 + shift);
            if b_target_idx >= 0 && b_target_idx < n as i32 {
                let val_a = profile_a[k];
                let val_b = profile_b[b_target_idx as usize];

                // For complementary Tab (positive) and Hole (negative), perfect match means val_a + val_b == 0.
                let residual = val_a + val_b;
                sum_sq += residual * residual;
                count += 1;
            }
        }

        if count > n / 2 {
            let l2 = (sum_sq / count as f32).sqrt();
            if l2 < best_l2 {
                best_l2 = l2;
                best_shift = shift;
            }
        }
    }

    if best_l2 == f32::MAX {
        (1.0, 0)
    } else {
        (best_l2, best_shift)
    }
}

/// Evaluates pairwise compatibility between two piece edges
pub fn evaluate_pairwise_edge_compatibility(
    edge_a: &PieceEdge,
    edge_b: &PieceEdge,
) -> PairwiseMatchResult {
    // 1. Fast rejection filter
    if let Some(reason) = fast_rejection_filter(
        edge_a.edge_type,
        edge_a.curvature_depth,
        edge_b.edge_type,
        edge_b.curvature_depth,
    ) {
        return PairwiseMatchResult {
            is_compatible: false,
            l2_distance: 1.0,
            alignment_offset: 0,
            confidence: 0.0,
            rejection_reason: Some(reason),
        };
    }

    // 2. Sliding window L2 profile curve matching
    let (l2_dist, best_shift) = compute_complementary_l2_distance(
        &edge_a.normalized_profile,
        &edge_b.normalized_profile,
        2, // +/- 2 samples alignment tolerance (~2% of chord length)
    );

    // 3. Map L2 distance to confidence score [0.0, 100.0]%
    // Typical die-cut complementary matches have L2 < 0.025 (discretization & noise).
    // Threshold for genuine physical mate is L2 < 0.045.
    // L2 >= 0.080 represents distinct non-matching curve shapes.
    let max_threshold = 0.075f32;
    let confidence = ((1.0 - (l2_dist / max_threshold)).max(0.0) * 100.0).min(100.0);
    let is_compatible = l2_dist <= 0.045;

    PairwiseMatchResult {
        is_compatible,
        l2_distance: l2_dist,
        alignment_offset: best_shift,
        confidence,
        rejection_reason: if is_compatible { None } else {
            Some(format!("Curve profile L2 mismatch: {:.4} (threshold 0.0450)", l2_dist))
        },
    }
}

/// Find all compatible mating edges for a query edge within a pool of candidate pieces
pub fn find_compatible_mating_candidates(
    query_edge: &PieceEdge,
    candidate_pieces: &[ScannedPiece],
    query_piece_idx: Option<usize>,
) -> Vec<EdgeMatingCandidate> {
    let mut candidates = Vec::new();

    for (p_idx, piece) in candidate_pieces.iter().enumerate() {
        if Some(p_idx) == query_piece_idx {
            continue; // Cannot mate with itself
        }

        for (e_idx, edge) in piece.edges.iter().enumerate() {
            let res = evaluate_pairwise_edge_compatibility(query_edge, edge);
            if res.is_compatible || res.l2_distance < 0.065 {
                candidates.push(EdgeMatingCandidate {
                    piece_index: p_idx,
                    edge_index: e_idx,
                    edge_type: edge.edge_type,
                    l2_distance: res.l2_distance,
                    alignment_offset: res.alignment_offset,
                    confidence: res.confidence,
                });
            }
        }
    }

    // Sort by best match (lowest L2 distance / highest confidence)
    candidates.sort_by(|a, b| a.l2_distance.partial_cmp(&b.l2_distance).unwrap_or(std::cmp::Ordering::Equal));
    candidates
}

// ---------------------------------------------------------------------------
// WASM Bindings for Web Application
// ---------------------------------------------------------------------------

/// Evaluate compatibility between two normalized edge profiles via WASM
#[wasm_bindgen]
pub fn evaluate_edge_pair_wasm(
    type_a: &str,
    depth_a: f32,
    profile_a: &[f32],
    type_b: &str,
    depth_b: f32,
    profile_b: &[f32],
) -> Result<JsValue, JsValue> {
    let parse_type = |s: &str| match s {
        "Tab" => EdgeType::Tab,
        "Hole" => EdgeType::Hole,
        _ => EdgeType::Flat,
    };

    let et_a = parse_type(type_a);
    let et_b = parse_type(type_b);

    if let Some(reason) = fast_rejection_filter(et_a, depth_a, et_b, depth_b) {
        let result = PairwiseMatchResult {
            is_compatible: false,
            l2_distance: 1.0,
            alignment_offset: 0,
            confidence: 0.0,
            rejection_reason: Some(reason),
        };
        return serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&e.to_string()));
    }

    let (l2_dist, best_shift) = compute_complementary_l2_distance(profile_a, profile_b, 2);
    let max_threshold = 0.075f32;
    let confidence = ((1.0 - (l2_dist / max_threshold)).max(0.0) * 100.0).min(100.0);
    let is_compatible = l2_dist <= 0.045;

    let result = PairwiseMatchResult {
        is_compatible,
        l2_distance: l2_dist,
        alignment_offset: best_shift,
        confidence,
        rejection_reason: if is_compatible { None } else {
            Some(format!("Curve profile L2 mismatch: {:.4}", l2_dist))
        },
    };

    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

// ---------------------------------------------------------------------------
// Drop-to-Locate Piece Identity Recognition
// ---------------------------------------------------------------------------

/// Compute direct L2 difference between two normalized profiles of the same edge
pub fn compute_profile_identity_distance(p_a: &[f32], p_b: &[f32]) -> f32 {
    let n = p_a.len().min(p_b.len());
    if n == 0 {
        return 1.0;
    }
    let mut sum_sq = 0.0f32;
    for i in 0..n {
        let diff = p_a[i] - p_b[i];
        sum_sq += diff * diff;
    }
    (sum_sq / n as f32).sqrt()
}

/// Result of identifying a physical piece placed on the stage
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PieceIdentityMatch {
    pub is_matched: bool,
    pub piece_id: String,
    pub piece_number: usize,
    pub rotation_offset: usize, // 0..3 (0, 90, 180, 270 deg CW)
    pub identity_distance: f32, // Mean L2 distance across 4 edges
    pub confidence: f32,        // [0.0, 100.0]%
}

/// Fast stored piece edge descriptor for in-memory matching
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct IndexedEdgeData {
    pub edge_type: EdgeType,
    pub curvature_depth: f32,
    pub normalized_profile: Vec<f32>,
}

/// Fast stored piece descriptor for in-memory matching
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct IndexedPieceData {
    pub id: String,
    pub piece_number: usize,
    pub classification: String, // "Corner", "Border", "Interior"
    pub edges: [IndexedEdgeData; 4],
    pub mean_rgb: Option<[u8; 3]>,
}

/// Identifies which stored piece matches the piece currently staged on the camera
pub fn identify_staged_piece_core(
    query_edges: &[IndexedEdgeData; 4],
    query_mean_rgb: Option<[u8; 3]>,
    stored_pieces: &[IndexedPieceData],
) -> Option<PieceIdentityMatch> {
    if stored_pieces.is_empty() {
        return None;
    }

    let mut best_piece_idx = None;
    let mut best_rot = 0usize;
    let mut best_dist = f32::MAX;

    for (p_idx, stored) in stored_pieces.iter().enumerate() {
        // Try all 4 rotational alignments (rot = 0, 1, 2, 3)
        for rot in 0..4 {
            let mut edge_types_match = true;
            for k in 0..4 {
                let stored_edge_idx = (k + rot) % 4;
                if query_edges[k].edge_type != stored.edges[stored_edge_idx].edge_type {
                    edge_types_match = false;
                    break;
                }
            }

            if !edge_types_match {
                continue;
            }

            // Compute edge profile distance across all 4 edges
            let mut total_edge_dist = 0.0f32;
            for k in 0..4 {
                let stored_edge_idx = (k + rot) % 4;
                let d = compute_profile_identity_distance(
                    &query_edges[k].normalized_profile,
                    &stored.edges[stored_edge_idx].normalized_profile,
                );
                total_edge_dist += d;
            }
            let mean_edge_dist = total_edge_dist / 4.0;

            // Optional color distance
            let combined_dist = if let (Some(q_rgb), Some(s_rgb)) = (query_mean_rgb, stored.mean_rgb) {
                let dr = (q_rgb[0] as f32 - s_rgb[0] as f32).abs();
                let dg = (q_rgb[1] as f32 - s_rgb[1] as f32).abs();
                let db = (q_rgb[2] as f32 - s_rgb[2] as f32).abs();
                let color_dist = (dr * dr + dg * dg + db * db).sqrt() / 441.67;
                0.80 * mean_edge_dist + 0.20 * color_dist
            } else {
                mean_edge_dist
            };

            if combined_dist < best_dist {
                best_dist = combined_dist;
                best_piece_idx = Some(p_idx);
                best_rot = rot;
            }
        }
    }

    if let Some(idx) = best_piece_idx {
        let piece = &stored_pieces[idx];
        // Threshold: For the exact same piece on the same mat, identity distance is typically < 0.020.
        // Threshold 0.045 tolerates lighting variation and slight hand drop jitter.
        let is_matched = best_dist <= 0.045;
        let confidence = ((1.0 - (best_dist / 0.045)).max(0.0) * 100.0).min(100.0);

        Some(PieceIdentityMatch {
            is_matched,
            piece_id: piece.id.clone(),
            piece_number: piece.piece_number,
            rotation_offset: best_rot,
            identity_distance: best_dist,
            confidence,
        })
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// 1D Closed Perimeter Loop Solver
// ---------------------------------------------------------------------------

/// Placement output for a piece in the solved border loop
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SolvedBorderPlacement {
    pub piece_id: String,
    pub piece_number: usize,
    pub row: usize,
    pub col: usize,
    pub rotation: usize, // 0, 1, 2, 3
    pub next_mate_id: Option<String>,
    pub curve_l2_residual: f32,
    pub confidence: f32,
}

/// Result of solving the complete perimeter loop
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SolvedPerimeterResult {
    pub success: bool,
    pub total_pieces_placed: usize,
    pub placements: Vec<SolvedBorderPlacement>,
    pub error_message: Option<String>,
}

/// Solves the closed 1D border loop connecting the 4 corners and all border pieces
pub fn solve_perimeter_1d_loop(
    pieces: &[IndexedPieceData],
    rows: usize,
    cols: usize,
) -> SolvedPerimeterResult {
    if rows < 3 || cols < 3 {
        return SolvedPerimeterResult {
            success: false,
            total_pieces_placed: 0,
            placements: vec![],
            error_message: Some("Board dimensions must be at least 3x3".to_string()),
        };
    }

    let corners: Vec<&IndexedPieceData> = pieces
        .iter()
        .filter(|p| p.edges.iter().filter(|e| e.edge_type == EdgeType::Flat).count() == 2)
        .collect();

    let borders: Vec<&IndexedPieceData> = pieces
        .iter()
        .filter(|p| p.edges.iter().filter(|e| e.edge_type == EdgeType::Flat).count() == 1)
        .collect();

    let expected_borders = 2 * (rows - 2) + 2 * (cols - 2);
    if corners.len() < 4 {
        return SolvedPerimeterResult {
            success: false,
            total_pieces_placed: 0,
            placements: vec![],
            error_message: Some(format!(
                "Need 4 corner pieces with 2 flat edges, found {}",
                corners.len()
            )),
        };
    }

    // Helper to get the edge pointing in world direction `dir` under clockwise rotation `rot`.
    // dir: 0: North, 1: East, 2: South, 3: West
    fn get_oriented_edge<'a>(p: &'a IndexedPieceData, rot: usize, dir: usize) -> &'a IndexedEdgeData {
        let original_idx = (dir + 4 - (rot % 4)) % 4;
        &p.edges[original_idx]
    }

    // Helper to find rotation (0..4 CW) where world directions `req_a` and `req_b` are both Flat.
    fn find_corner_rotation(p: &IndexedPieceData, req_a: usize, req_b: usize) -> Option<usize> {
        for rot in 0..4 {
            let edge_a = (req_a + 4 - (rot % 4)) % 4;
            let edge_b = (req_b + 4 - (rot % 4)) % 4;
            if p.edges[edge_a].edge_type == EdgeType::Flat && p.edges[edge_b].edge_type == EdgeType::Flat {
                return Some(rot);
            }
        }
        None
    }

    // Helper to find rotation (0..4 CW) where world direction `flat_dir` is Flat.
    fn find_border_rotation(p: &IndexedPieceData, flat_dir: usize) -> Option<usize> {
        for rot in 0..4 {
            let edge_idx = (flat_dir + 4 - (rot % 4)) % 4;
            if p.edges[edge_idx].edge_type == EdgeType::Flat {
                return Some(rot);
            }
        }
        None
    }

    fn chain_border_side<'a>(
        prev_start_edge: &'a IndexedEdgeData,
        count: usize,
        flat_dir: usize,
        mate_dir: usize,
        next_edge_dir: usize,
        corner_target_edge: &'a IndexedEdgeData,
        borders: &[&'a IndexedPieceData],
        used: &mut std::collections::HashSet<String>,
        row_col_fn: &dyn Fn(usize) -> (usize, usize),
        out_placements: &mut Vec<SolvedBorderPlacement>,
    ) -> (&'a IndexedEdgeData, f32, bool) {
        let mut prev_edge = prev_start_edge;
        let mut side_score = 0.0f32;

        for step in 0..count {
            let mut candidates: Vec<(&'a IndexedPieceData, usize, f32)> = Vec::new();
            for &bp in borders {
                if used.contains(&bp.id) {
                    continue;
                }
                if let Some(rot) = find_border_rotation(bp, flat_dir) {
                    let mate_edge = get_oriented_edge(bp, rot, mate_dir);
                    if fast_rejection_filter(
                        prev_edge.edge_type,
                        prev_edge.curvature_depth,
                        mate_edge.edge_type,
                        mate_edge.curvature_depth,
                    ).is_none() {
                        let (l2, _) = compute_complementary_l2_distance(
                            &prev_edge.normalized_profile,
                            &mate_edge.normalized_profile,
                            3,
                        );
                        if l2 < 0.16 {
                            candidates.push((bp, rot, l2));
                        }
                    }
                }
            }

            if candidates.is_empty() {
                break;
            }

            candidates.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));

            let mut chosen = None;
            for &(cand_bp, cand_rot, cand_l2) in candidates.iter().take(2) {
                let cand_next_edge = get_oriented_edge(cand_bp, cand_rot, next_edge_dir);
                if step + 1 == count {
                    if fast_rejection_filter(
                        cand_next_edge.edge_type,
                        cand_next_edge.curvature_depth,
                        corner_target_edge.edge_type,
                        corner_target_edge.curvature_depth,
                    ).is_none() {
                        let (seam_l2, _) = compute_complementary_l2_distance(
                            &cand_next_edge.normalized_profile,
                            &corner_target_edge.normalized_profile,
                            3,
                        );
                        if seam_l2 < 0.18 {
                            chosen = Some((cand_bp, cand_rot, cand_l2));
                            break;
                        }
                    }
                } else {
                    let mut has_successor = false;
                    for &next_bp in borders {
                        if used.contains(&next_bp.id) || next_bp.id == cand_bp.id {
                            continue;
                        }
                        if let Some(n_rot) = find_border_rotation(next_bp, flat_dir) {
                            let n_mate = get_oriented_edge(next_bp, n_rot, mate_dir);
                            if fast_rejection_filter(
                                cand_next_edge.edge_type,
                                cand_next_edge.curvature_depth,
                                n_mate.edge_type,
                                n_mate.curvature_depth,
                            ).is_none() {
                                let (n_l2, _) = compute_complementary_l2_distance(
                                    &cand_next_edge.normalized_profile,
                                    &n_mate.normalized_profile,
                                    3,
                                );
                                if n_l2 < 0.16 {
                                    has_successor = true;
                                    break;
                                }
                            }
                        }
                    }
                    if has_successor {
                        chosen = Some((cand_bp, cand_rot, cand_l2));
                        break;
                    }
                }
            }

            let (bp, rot, l2) = chosen.unwrap_or(candidates[0]);

            used.insert(bp.id.clone());
            side_score += 10.0 + (0.16 - l2);
            let conf = ((1.0 - l2 / 0.16).max(0.0) * 100.0).min(100.0);
            let (r, c) = row_col_fn(step);
            out_placements.push(SolvedBorderPlacement {
                piece_id: bp.id.clone(),
                piece_number: bp.piece_number,
                row: r,
                col: c,
                rotation: rot,
                next_mate_id: None,
                curve_l2_residual: l2,
                confidence: conf,
            });

            prev_edge = get_oriented_edge(bp, rot, next_edge_dir);
        }

        let mut seam_closed = false;
        if fast_rejection_filter(
            prev_edge.edge_type,
            prev_edge.curvature_depth,
            corner_target_edge.edge_type,
            corner_target_edge.curvature_depth,
        ).is_none() {
            let (seam_l2, _) = compute_complementary_l2_distance(
                &prev_edge.normalized_profile,
                &corner_target_edge.normalized_profile,
                3,
            );
            if seam_l2 < 0.18 {
                seam_closed = true;
                side_score += 50.0 + (0.18 - seam_l2);
            }
        }

        (prev_edge, side_score, seam_closed)
    }

    fn try_perimeter_permutation<'a>(
        c_tl: &'a IndexedPieceData,
        c_tr: &'a IndexedPieceData,
        c_br: &'a IndexedPieceData,
        c_bl: &'a IndexedPieceData,
        borders: &[&'a IndexedPieceData],
        rows: usize,
        cols: usize,
    ) -> (Vec<SolvedBorderPlacement>, f32, usize) {
        let r_tl = match find_corner_rotation(c_tl, 0, 3) {
            Some(r) => r,
            None => return (vec![], -1e9, 0),
        };
        let r_tr = match find_corner_rotation(c_tr, 0, 1) {
            Some(r) => r,
            None => return (vec![], -1e9, 0),
        };
        let r_br = match find_corner_rotation(c_br, 2, 1) {
            Some(r) => r,
            None => return (vec![], -1e9, 0),
        };
        let r_bl = match find_corner_rotation(c_bl, 2, 3) {
            Some(r) => r,
            None => return (vec![], -1e9, 0),
        };

        let mut placements = Vec::new();
        let mut used = std::collections::HashSet::new();
        used.insert(c_tl.id.clone());
        used.insert(c_tr.id.clone());
        used.insert(c_br.id.clone());
        used.insert(c_bl.id.clone());

        let mut total_score = 0.0f32;
        let mut closed_seams = 0usize;

        // Corner TL
        placements.push(SolvedBorderPlacement {
            piece_id: c_tl.id.clone(),
            piece_number: c_tl.piece_number,
            row: 0,
            col: 0,
            rotation: r_tl,
            next_mate_id: None,
            curve_l2_residual: 0.0,
            confidence: 100.0,
        });

        // Chain 1: Top (col 1 .. cols - 2)
        let tl_east = get_oriented_edge(c_tl, r_tl, 1);
        let tr_west = get_oriented_edge(c_tr, r_tr, 3);
        let (_end_top, s1_score, s1_closed) = chain_border_side(
            tl_east,
            cols - 2,
            0, // Flat North
            3, // Mate West
            1, // Next East
            tr_west,
            borders,
            &mut used,
            &|step| (0, step + 1),
            &mut placements,
        );
        total_score += s1_score;
        if s1_closed { closed_seams += 1; }

        // Corner TR
        placements.push(SolvedBorderPlacement {
            piece_id: c_tr.id.clone(),
            piece_number: c_tr.piece_number,
            row: 0,
            col: cols - 1,
            rotation: r_tr,
            next_mate_id: None,
            curve_l2_residual: 0.0,
            confidence: 100.0,
        });

        // Chain 2: Right (row 1 .. rows - 2)
        let tr_south = get_oriented_edge(c_tr, r_tr, 2);
        let br_north = get_oriented_edge(c_br, r_br, 0);
        let (_end_right, s2_score, s2_closed) = chain_border_side(
            tr_south,
            rows - 2,
            1, // Flat East
            0, // Mate North
            2, // Next South
            br_north,
            borders,
            &mut used,
            &|step| (step + 1, cols - 1),
            &mut placements,
        );
        total_score += s2_score;
        if s2_closed { closed_seams += 1; }

        // Corner BR
        placements.push(SolvedBorderPlacement {
            piece_id: c_br.id.clone(),
            piece_number: c_br.piece_number,
            row: rows - 1,
            col: cols - 1,
            rotation: r_br,
            next_mate_id: None,
            curve_l2_residual: 0.0,
            confidence: 100.0,
        });

        // Chain 3: Bottom (col cols - 2 down to 1)
        let br_west = get_oriented_edge(c_br, r_br, 3);
        let bl_east = get_oriented_edge(c_bl, r_bl, 1);
        let (_end_bottom, s3_score, s3_closed) = chain_border_side(
            br_west,
            cols - 2,
            2, // Flat South
            1, // Mate East
            3, // Next West
            bl_east,
            borders,
            &mut used,
            &|step| (rows - 1, (cols - 2) - step),
            &mut placements,
        );
        total_score += s3_score;
        if s3_closed { closed_seams += 1; }

        // Corner BL
        placements.push(SolvedBorderPlacement {
            piece_id: c_bl.id.clone(),
            piece_number: c_bl.piece_number,
            row: rows - 1,
            col: 0,
            rotation: r_bl,
            next_mate_id: None,
            curve_l2_residual: 0.0,
            confidence: 100.0,
        });

        // Chain 4: Left (row rows - 2 down to 1)
        let bl_north = get_oriented_edge(c_bl, r_bl, 0);
        let tl_south = get_oriented_edge(c_tl, r_tl, 2);
        let (_end_left, s4_score, s4_closed) = chain_border_side(
            bl_north,
            rows - 2,
            3, // Flat West
            2, // Mate South
            0, // Next North
            tl_south,
            borders,
            &mut used,
            &|step| ((rows - 2) - step, 0),
            &mut placements,
        );
        total_score += s4_score;
        if s4_closed { closed_seams += 1; }

        (placements, total_score, closed_seams)
    }

    const CORNER_PERMUTATIONS: [[usize; 4]; 24] = [
        [0,1,2,3], [0,1,3,2], [0,2,1,3], [0,2,3,1], [0,3,1,2], [0,3,2,1],
        [1,0,2,3], [1,0,3,2], [1,2,0,3], [1,2,3,0], [1,3,0,2], [1,3,2,0],
        [2,0,1,3], [2,0,3,1], [2,1,0,3], [2,1,3,0], [2,3,0,1], [2,3,1,0],
        [3,0,1,2], [3,0,2,1], [3,1,0,2], [3,1,2,0], [3,2,0,1], [3,2,1,0],
    ];

    let dim_candidates = vec![(rows, cols)];

    let corner_subsets: Vec<[&IndexedPieceData; 4]> = if corners.len() == 4 {
        vec![[corners[0], corners[1], corners[2], corners[3]]]
    } else {
        let mut subs = Vec::new();
        let n_c = corners.len().min(6);
        for a in 0..n_c {
            for b in (a + 1)..n_c {
                for c in (b + 1)..n_c {
                    for d in (c + 1)..n_c {
                        subs.push([corners[a], corners[b], corners[c], corners[d]]);
                    }
                }
            }
        }
        subs
    };

    let mut best_placements: Vec<SolvedBorderPlacement> = Vec::new();
    let mut best_score = -1e9f32;
    let mut best_expected = expected_borders + 4;

    for &(cur_rows, cur_cols) in &dim_candidates {
        let cur_expected_borders = 2 * (cur_rows - 2) + 2 * (cur_cols - 2);
        let cur_total_expected = cur_expected_borders + 4;

        for subset in &corner_subsets {
            for perm in &CORNER_PERMUTATIONS {
                let c_tl = subset[perm[0]];
                let c_tr = subset[perm[1]];
                let c_br = subset[perm[2]];
                let c_bl = subset[perm[3]];

                let (plcs, score, closed_seams) = try_perimeter_permutation(
                    c_tl, c_tr, c_br, c_bl, &borders, cur_rows, cur_cols,
                );

                if plcs.len() == cur_total_expected && closed_seams == 4 {
                    return SolvedPerimeterResult {
                        success: true,
                        total_pieces_placed: plcs.len(),
                        placements: plcs,
                        error_message: None,
                    };
                }

                if score > best_score {
                    best_score = score;
                    best_placements = plcs;
                    best_expected = cur_total_expected;
                }
            }
        }
    }

    let total = best_placements.len();
    SolvedPerimeterResult {
        success: total == best_expected,
        total_pieces_placed: total,
        placements: best_placements,
        error_message: if total < best_expected {
            Some(format!(
                "Solved {} / {} perimeter pieces. Missing {} pieces in current scan pool.",
                total,
                best_expected,
                best_expected.saturating_sub(total)
            ))
        } else {
            None
        },
    }
}

// ---------------------------------------------------------------------------
// WASM Bindings for Drop-to-Locate and Perimeter Solving
// ---------------------------------------------------------------------------

/// Identifies a staged piece against the pool of stored pieces
#[wasm_bindgen]
pub fn identify_staged_piece_wasm(
    query_edges_json: &str,
    stored_pieces_json: &str,
) -> Result<JsValue, JsValue> {
    let query_edges: [IndexedEdgeData; 4] = serde_json::from_str(query_edges_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid query_edges JSON: {}", e)))?;

    let stored_pieces: Vec<IndexedPieceData> = serde_json::from_str(stored_pieces_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid stored_pieces JSON: {}", e)))?;

    let match_res = identify_staged_piece_core(&query_edges, None, &stored_pieces);
    serde_wasm_bindgen::to_value(&match_res)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Solves the perimeter 1D loop for given pieces and board dimensions
#[wasm_bindgen]
pub fn solve_perimeter_1d_loop_wasm(
    pieces_json: &str,
    rows: usize,
    cols: usize,
) -> Result<JsValue, JsValue> {
    let pieces: Vec<IndexedPieceData> = serde_json::from_str(pieces_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid pieces JSON: {}", e)))?;

    let result = solve_perimeter_1d_loop(&pieces, rows, cols);
    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
