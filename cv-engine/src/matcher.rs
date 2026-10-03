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

/// Fast stored piece edge descriptor for in-memory matching and Phase 7 multimodal solver
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct IndexedEdgeData {
    pub edge_type: EdgeType,
    pub curvature_depth: f32,
    pub normalized_profile: Vec<f32>,
    /// Step 2: Metric chord baseline length in mm (calibrated via 96px = 25.0mm stage)
    #[serde(default)]
    pub chord_length_mm: f32,
    /// Step 2: Metric tab protrusion height or hole indentation depth in mm
    #[serde(default)]
    pub tab_depth_mm: f32,
    /// Step 2: Metric tab neck width in mm
    #[serde(default)]
    pub tab_width_mm: f32,
    /// Step 3: Seam ink color samples (RGB) along the edge cut for MGC color continuity
    #[serde(default)]
    pub seam_rgb_samples: Vec<[u8; 3]>,
}

impl IndexedEdgeData {
    pub fn new(edge_type: EdgeType, curvature_depth: f32, normalized_profile: Vec<f32>) -> Self {
        Self {
            edge_type,
            curvature_depth,
            normalized_profile,
            chord_length_mm: 0.0,
            tab_depth_mm: 0.0,
            tab_width_mm: 0.0,
            seam_rgb_samples: Vec::new(),
        }
    }
}

impl Default for IndexedEdgeData {
    fn default() -> Self {
        Self {
            edge_type: EdgeType::Flat,
            curvature_depth: 0.0,
            normalized_profile: Vec::new(),
            chord_length_mm: 0.0,
            tab_depth_mm: 0.0,
            tab_width_mm: 0.0,
            seam_rgb_samples: Vec::new(),
        }
    }
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
// ---------------------------------------------------------------------------
// Phase 7: Cascading 7-Step Universal Mating Pipeline
// ---------------------------------------------------------------------------

/// Step 1: Fast edge polarity check (Tab requires Hole, Flat never mates with interlocking features)
#[inline]
pub fn check_step1_edge_topology(type_a: EdgeType, type_b: EdgeType) -> bool {
    matches!(
        (type_a, type_b),
        (EdgeType::Tab, EdgeType::Hole) | (EdgeType::Hole, EdgeType::Tab)
    )
}

/// Step 2: Metric dimension tolerance check (±0.3 mm)
/// Tolerates minor cardboard compression while rejecting geometrically impossible pairings.
#[inline]
pub fn check_step2_metric_tolerances(
    edge_a: &IndexedEdgeData,
    edge_b: &IndexedEdgeData,
    tolerance_mm: f32,
) -> bool {
    // If metric lengths are recorded (> 0.0 mm), enforce strict millimeter bounds
    if edge_a.chord_length_mm > 0.0 && edge_b.chord_length_mm > 0.0 {
        let chord_diff = (edge_a.chord_length_mm - edge_b.chord_length_mm).abs();
        if chord_diff > tolerance_mm {
            return false;
        }
    }

    if edge_a.tab_depth_mm > 0.0 && edge_b.tab_depth_mm > 0.0 {
        let depth_diff = (edge_a.tab_depth_mm - edge_b.tab_depth_mm).abs();
        if depth_diff > tolerance_mm {
            return false;
        }
    }

    if edge_a.tab_width_mm > 0.0 && edge_b.tab_width_mm > 0.0 {
        let width_diff = (edge_a.tab_width_mm - edge_b.tab_width_mm).abs();
        if width_diff > tolerance_mm {
            return false;
        }
    }

    true
}

/// Step 3: Seam Ink Continuity (Modified Gradient Compatibility / MGC)
/// Measures color/gradient compatibility across candidate cut seams:
/// Cost_MGC(u, v) = sum_k || I_u(k) - I_v(rev(k)) ||^2
/// Traverses edge_b in reverse since edges meet opposite along the cut seam.
/// Returns normalized color discontinuity cost in [0.0, 1.0]. Lower is better.
pub fn compute_step3_seam_ink_mgc(
    samples_a: &[[u8; 3]],
    samples_b: &[[u8; 3]],
) -> f32 {
    let n = samples_a.len().min(samples_b.len());
    if n == 0 {
        return 0.0; // If color strips not present, neutral cost
    }

    let mut sum_sq_diff = 0.0f32;
    for k in 0..n {
        let b_idx = n - 1 - k; // Traversed in reverse
        let color_a = samples_a[k];
        let color_b = samples_b[b_idx];

        let dr = color_a[0] as f32 - color_b[0] as f32;
        let dg = color_a[1] as f32 - color_b[1] as f32;
        let db = color_a[2] as f32 - color_b[2] as f32;

        // Perceptually weighted Euclidean RGB color difference squared
        let d_sq = 0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db;
        sum_sq_diff += d_sq;
    }

    let mean_d_sq = sum_sq_diff / n as f32;
    // Max possible difference is 255^2 = 65025
    (mean_d_sq / 65025.0).sqrt().clamp(0.0, 1.0)
}

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

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SolvedPerimeterResult {
    pub success: bool,
    pub total_pieces_placed: usize,
    pub placements: Vec<SolvedBorderPlacement>,
    pub error_message: Option<String>,
}

/// Placeholder entry point for Phase 7 Universal Mating Pipeline
pub fn solve_perimeter_1d_loop(
    _pieces: &[IndexedPieceData],
    _rows: usize,
    _cols: usize,
) -> SolvedPerimeterResult {
    SolvedPerimeterResult {
        success: false,
        total_pieces_placed: 0,
        placements: vec![],
        error_message: Some("Phase 7 solver pipeline initialization in progress".to_string()),
    }
}

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
