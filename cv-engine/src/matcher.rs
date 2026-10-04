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
/// Computes the complementary L2 distance and L_inf (Chebyshev maximum local collision/gap)
/// between Edge A profile and Edge B profile under optimal sliding alignment within ±max_shift.
///
/// Returns (best_l2_distance, best_linf_distance, best_shift_offset).
pub fn compute_complementary_l2_distance(
    profile_a: &[f32],
    profile_b: &[f32],
    max_shift: i32,
) -> (f32, f32, i32) {
    let n = profile_a.len().min(profile_b.len());
    if n < 10 {
        return (1.0, 1.0, 0);
    }

    let mut best_l2 = f32::MAX;
    let mut best_linf = f32::MAX;
    let mut best_shift = 0;

    for shift in -max_shift..=max_shift {
        let mut sum_sq_comp = 0.0f32; // If Tab is positive and Hole is negative: val_a + val_b == 0
        let mut sum_sq_diff = 0.0f32; // If both profiles have same sign orientation: val_a - val_b == 0
        let mut max_abs_comp = 0.0f32;
        let mut max_abs_diff = 0.0f32;
        let mut count = 0usize;

        for k in 0..n {
            // Profile B is traversed in reverse (from n - 1 down to 0) along the common seam.
            let b_target_idx = (n as i32 - 1) - (k as i32 + shift);
            if b_target_idx >= 0 && b_target_idx < n as i32 {
                let val_a = profile_a[k];
                let val_b = profile_b[b_target_idx as usize];

                let res_comp = val_a + val_b;
                let res_diff = val_a - val_b;
                sum_sq_comp += res_comp * res_comp;
                sum_sq_diff += res_diff * res_diff;
                max_abs_comp = max_abs_comp.max(res_comp.abs());
                max_abs_diff = max_abs_diff.max(res_diff.abs());
                count += 1;
            }
        }

        if count > n / 2 {
            let l2_comp = (sum_sq_comp / count as f32).sqrt();
            let l2_diff = (sum_sq_diff / count as f32).sqrt();
            let (l2, linf) = if l2_comp <= l2_diff {
                (l2_comp, max_abs_comp)
            } else {
                (l2_diff, max_abs_diff)
            };
            if l2 < best_l2 {
                best_l2 = l2;
                best_linf = linf;
                best_shift = shift;
            }
        }
    }

    if best_l2 == f32::MAX {
        (1.0, 1.0, 0)
    } else {
        (best_l2, best_linf, best_shift)
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
    let (l2_dist, _linf_dist, best_shift) = compute_complementary_l2_distance(
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

    let (l2_dist, _linf_dist, best_shift) = compute_complementary_l2_distance(profile_a, profile_b, 2);
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

/// Checks whether an edge pairing between two pieces is topologically permissible.
/// If both Piece A and Piece B are Border pieces (possessing exactly 1 flat outer edge),
/// they can only mate along edges that are adjacent to their flat edge (clockwise or counter-clockwise
/// along the perimeter line). Mating along their interior-facing edges (opposite to the flat edge)
/// is topologically impossible on any grid where min(rows, cols) > 2.
#[inline]
pub fn check_step1_border_topology(
    piece_a: &IndexedPieceData,
    edge_a_idx: usize,
    piece_b: &IndexedPieceData,
    edge_b_idx: usize,
) -> bool {
    let a_flat_indices: Vec<usize> = piece_a.edges.iter().enumerate()
        .filter_map(|(i, e)| if e.edge_type == EdgeType::Flat { Some(i) } else { None })
        .collect();
    let b_flat_indices: Vec<usize> = piece_b.edges.iter().enumerate()
        .filter_map(|(i, e)| if e.edge_type == EdgeType::Flat { Some(i) } else { None })
        .collect();

    // If both pieces are Border pieces (exactly 1 flat edge)
    if a_flat_indices.len() == 1 && b_flat_indices.len() == 1 {
        let a_flat = a_flat_indices[0];
        let b_flat = b_flat_indices[0];

        // The edge opposite to the flat edge is the interior edge
        let a_interior = (a_flat + 2) % 4;
        let b_interior = (b_flat + 2) % 4;

        if edge_a_idx == a_interior || edge_b_idx == b_interior {
            return false;
        }
    }

    true
}

/// Step 2: Metric dimension tolerance check
/// Tolerates cardboard die-cut variance and camera perspective/corner placement jitter,
/// while rejecting geometrically impossible pairings.
/// Real physical cardboard die-cuts with corner pin jitter typically have ±0.8 to ±1.5 mm chord variance.
#[inline]
pub fn check_step2_metric_tolerances(
    edge_a: &IndexedEdgeData,
    edge_b: &IndexedEdgeData,
    tolerance_mm: f32,
) -> bool {
    // If metric lengths are recorded (> 0.0 mm), enforce millimeter bounds
    if edge_a.chord_length_mm > 0.0 && edge_b.chord_length_mm > 0.0 {
        let chord_diff = (edge_a.chord_length_mm - edge_b.chord_length_mm).abs();
        if chord_diff > tolerance_mm {
            return false;
        }
    }

    if edge_a.tab_depth_mm > 0.0 && edge_b.tab_depth_mm > 0.0 {
        let depth_diff = (edge_a.tab_depth_mm - edge_b.tab_depth_mm).abs();
        let depth_tol = (tolerance_mm + 0.5).max(2.0);
        if depth_diff > depth_tol {
            return false;
        }
    }

    if edge_a.tab_width_mm > 0.0 && edge_b.tab_width_mm > 0.0 {
        let width_diff = (edge_a.tab_width_mm - edge_b.tab_width_mm).abs();
        let width_tol = tolerance_mm.max(2.0);
        if width_diff > width_tol {
            return false;
        }
    }

    true
}

/// Step 3: Seam Ink Continuity (Modified Gradient Compatibility / MGC)
/// Evaluates perceptual color continuity (CIELAB Delta E) and boundary gradient compatibility across candidate cut seams:
/// Cost_MGC = 0.65 * DeltaE_norm + 0.35 * GradientDiff_norm
/// Traverses edge_b in reverse since edges meet opposite along the cut seam.
/// In CIELAB, DeltaE < 12 is visually seamless, while DeltaE > 25 is an obvious color discontinuity.
/// Calibrated so DeltaE ~ 12 maps to ~0.10, DeltaE ~ 25 maps to ~0.22 (the rejection ceiling),
/// and different artwork pieces (DeltaE > 45) reach > 0.40.
/// Returns normalized ink discontinuity cost in [0.0, 1.0]. Lower is better.
pub fn compute_step3_seam_ink_mgc(
    samples_a: &[[u8; 3]],
    samples_b: &[[u8; 3]],
) -> f32 {
    let n = samples_a.len().min(samples_b.len());
    if n < 2 {
        return -1.0; // If color strips not present, return -1.0 indicator
    }

    let mut delta_es = Vec::with_capacity(n);
    let mut sum_grad_sq = 0.0f32;
    let mut grad_count = 0usize;

    for k in 0..n {
        let b_idx = n - 1 - k; // Traversed in reverse
        let color_a = samples_a[k];
        let color_b = samples_b[b_idx];

        // Skip unpainted transparent or black background bleed samples
        let is_valid_a = color_a[0] > 10 || color_a[1] > 10 || color_a[2] > 10;
        let is_valid_b = color_b[0] > 10 || color_b[1] > 10 || color_b[2] > 10;
        if !is_valid_a || !is_valid_b {
            continue;
        }

        // Convert sRGB to CIELAB for perceptually uniform color difference
        let lab_a = crate::poster::rgb_to_cielab(color_a[0], color_a[1], color_a[2]);
        let lab_b = crate::poster::rgb_to_cielab(color_b[0], color_b[1], color_b[2]);

        let d_l = lab_a[0] - lab_b[0];
        let d_a = lab_a[1] - lab_b[1];
        let d_b = lab_a[2] - lab_b[2];
        let delta_e = (d_l * d_l + d_a * d_a + d_b * d_b).sqrt();
        delta_es.push(delta_e);

        // Tangential gradient along the cut seam in CIELAB space:
        // Gradients should be consistent along adjacent matching boundaries
        if k + 1 < n {
            let next_b_idx = n - 1 - (k + 1);
            let next_a = samples_a[k + 1];
            let next_b = samples_b[next_b_idx];

            let next_valid_a = next_a[0] > 10 || next_a[1] > 10 || next_a[2] > 10;
            let next_valid_b = next_b[0] > 10 || next_b[1] > 10 || next_b[2] > 10;

            if next_valid_a && next_valid_b {
                let next_lab_a = crate::poster::rgb_to_cielab(next_a[0], next_a[1], next_a[2]);
                let next_lab_b = crate::poster::rgb_to_cielab(next_b[0], next_b[1], next_b[2]);

                // Derivative along edge A
                let grad_a_l = next_lab_a[0] - lab_a[0];
                let grad_a_a = next_lab_a[1] - lab_a[1];
                let grad_a_b = next_lab_a[2] - lab_a[2];

                // In reverse traversal, derivative direction along common seam is reversed
                let grad_b_l = lab_b[0] - next_lab_b[0];
                let grad_b_a = lab_b[1] - next_lab_b[1];
                let grad_b_b = lab_b[2] - next_lab_b[2];

                let d_gl = grad_a_l - grad_b_l;
                let d_ga = grad_a_a - grad_b_a;
                let d_gb = grad_a_b - grad_b_b;

                sum_grad_sq += d_gl * d_gl + d_ga * d_ga + d_gb * d_gb;
                grad_count += 1;
            }
        }
    }

    if delta_es.len() < 5 {
        return -1.0;
    }

    delta_es.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n_valid = delta_es.len();
    let median_de = delta_es[n_valid / 2];
    let p75_de = delta_es[(n_valid as f32 * 0.75) as usize];
    let p90_de = delta_es[(n_valid as f32 * 0.90) as usize];

    // Count extreme localized color clashes (Delta E > 48) along the seam
    let clash_count = delta_es.iter().filter(|&&de| de > 48.0).count();
    let clash_ratio = clash_count as f32 / n_valid as f32;

    // Blend median (robust to noise), 75th percentile, and 90th percentile (capturing localized discrepancies)
    let robust_delta_e = 0.45 * median_de + 0.45 * p75_de + 0.10 * p90_de;

    // Calibrated CIELAB scaling:
    // Genuine mates have low median (~10-12), modest p75 (~22), and minimal clash (<7%).
    // False mates have elevated tails (p90 > 50) and localized clashes > 10% (e.g. black meeting white).
    let color_cost = (robust_delta_e / 72.0).clamp(0.0, 1.0);

    let grad_cost = if grad_count > 0 {
        let mean_grad = (sum_grad_sq / grad_count as f32).sqrt();
        (mean_grad / 80.0).clamp(0.0, 1.0)
    } else {
        color_cost
    };

    let base_cost = 0.70 * color_cost + 0.30 * grad_cost;

    // Tail clash penalty: if more than 7% of points along the seam have Delta E > 48,
    // apply an escalating physical penalty because adjacent cuts cannot have stark color ruptures.
    let tail_penalty = if clash_ratio > 0.07 {
        ((clash_ratio - 0.07) * 2.5).clamp(0.0, 0.35)
    } else {
        0.0
    };

    (base_cost + tail_penalty).clamp(0.0, 1.0)
}

/// Result of Step 4 Sub-pixel Interlocking Contour Analysis
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SubpixelInterlockResult {
    pub is_physically_compatible: bool,
    pub l2_curve_distance: f32,
    pub linf_curve_distance: f32,
    pub alignment_shift: i32,
    pub combined_compatibility_score: f32, // [0.0, 1.0], 1.0 is best fit
}

/// Step 4: Sub-pixel Interlocking Contour Analysis
/// Tests complementary curve matching with sliding window alignment to absorb corner jitter,
/// enforcing mechanical fit tolerances (L2 <= 0.045 for strong fit, <= 0.070 for candidate fit,
/// and Chebyshev Linf <= 0.120 to reject physical collisions/excessive gaps).
pub fn check_step4_subpixel_contour(
    profile_a: &[f32],
    profile_b: &[f32],
    max_shift: i32,
) -> SubpixelInterlockResult {
    let (l2_dist, linf_dist, best_shift) = compute_complementary_l2_distance(profile_a, profile_b, max_shift);

    // Thresholds:
    // L2 < 0.025: near-perfect complementary die cut
    // L2 < 0.045: genuine physical mate on cardboard
    // L2 > 0.070: rejected mechanical mismatch
    // Linf > 0.120: rejected physical collision / excessive penetration gap
    let max_l2_tolerance = 0.070f32;
    let max_linf_tolerance = 0.120f32;
    let is_physically_compatible = l2_dist <= max_l2_tolerance && linf_dist <= max_linf_tolerance;
    let score = ((1.0 - (l2_dist / max_l2_tolerance)).max(0.0)).min(1.0);

    SubpixelInterlockResult {
        is_physically_compatible,
        l2_curve_distance: l2_dist,
        linf_curve_distance: linf_dist,
        alignment_shift: best_shift,
        combined_compatibility_score: score,
    }
}

/// Evaluates Steps 1 through 4 between two candidate edges.
/// Returns None if rejected by topology, metric millimeter tolerances, or physical curve fit.
/// Returns Some(score) where higher score represents a better physical match.
pub fn evaluate_candidate_edge_pair(
    edge_a: &IndexedEdgeData,
    edge_b: &IndexedEdgeData,
    tolerance_mm: f32,
) -> Option<f32> {
    // Step 1: Edge Topology Filtering (O(1))
    if !check_step1_edge_topology(edge_a.edge_type, edge_b.edge_type) {
        return None;
    }

    // Step 2: Metric Dimension Tolerances (±0.3 mm)
    if !check_step2_metric_tolerances(edge_a, edge_b, tolerance_mm) {
        return None;
    }

    // Step 4: Sub-pixel Interlocking Contour Analysis
    let contour_res = check_step4_subpixel_contour(
        &edge_a.normalized_profile,
        &edge_b.normalized_profile,
        2, // ±2 samples alignment tolerance (~2% chord length)
    );
    if !contour_res.is_physically_compatible {
        return None;
    }

    // Step 3: Seam Ink Continuity (MGC)
    let ink_cost = compute_step3_seam_ink_mgc(
        &edge_a.seam_rgb_samples,
        &edge_b.seam_rgb_samples,
    );

    // Active Seam MGC Gate: If printed ink samples exist on both edges, reject color discontinuities (>0.30)
    let has_ink_samples = !edge_a.seam_rgb_samples.is_empty() && !edge_b.seam_rgb_samples.is_empty();
    if has_ink_samples && ink_cost > 0.30 {
        return None;
    }

    // Multimodal fusion:
    // If seam ink samples are available, contour score is weighted and penalized by ink discontinuity.
    // If only geometry is available, contour score dominates.
    let fused_score = if has_ink_samples {
        let ink_factor = (1.0 - (ink_cost / 0.30).min(1.0)).powi(2);
        contour_res.combined_compatibility_score * (0.50 + 0.50 * ink_factor)
    } else {
        contour_res.combined_compatibility_score
    };

    Some(fused_score)
}

/// A directed edge candidate match in the inventory
#[derive(Clone, Debug)]
pub struct CandidateSeamMatch {
    pub piece_idx: usize,
    pub edge_idx: usize,
    pub score: f32,
}

/// Step 5: Mutual Best-Buddies Graph
/// Lock pairs into rigid micro-clusters if and only if:
/// Rank(A -> B) == 1 AND Rank(B -> A) == 1
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct MutualBestBuddyPair {
    pub piece_a_id: String,
    pub piece_a_idx: usize,
    pub edge_a_idx: usize,
    pub piece_b_id: String,
    pub piece_b_idx: usize,
    pub edge_b_idx: usize,
    pub score: f32,
}

/// Identifies all Mutual Best-Buddies across the candidate piece set
pub fn find_mutual_best_buddies(
    pieces: &[IndexedPieceData],
    tolerance_mm: f32,
) -> Vec<MutualBestBuddyPair> {
    let n = pieces.len();
    if n < 2 {
        return Vec::new();
    }

    // best_for_edge[p_idx][e_idx] = Option<CandidateSeamMatch>
    let mut best_for_edge: Vec<[Option<CandidateSeamMatch>; 4]> = vec![[None, None, None, None]; n];

    for p_a in 0..n {
        for e_a in 0..4 {
            let edge_a = &pieces[p_a].edges[e_a];
            if edge_a.edge_type == EdgeType::Flat {
                continue; // Flat border/corner edges do not mate
            }

            let mut best_cand: Option<CandidateSeamMatch> = None;

            for p_b in 0..n {
                if p_a == p_b {
                    continue; // Cannot mate with itself
                }

                for e_b in 0..4 {
                    let edge_b = &pieces[p_b].edges[e_b];
                    if edge_b.edge_type == EdgeType::Flat {
                        continue;
                    }

                    if !check_step1_border_topology(&pieces[p_a], e_a, &pieces[p_b], e_b) {
                        continue;
                    }

                    if let Some(score) = evaluate_candidate_edge_pair(edge_a, edge_b, tolerance_mm) {
                        match &best_cand {
                            None => {
                                best_cand = Some(CandidateSeamMatch { piece_idx: p_b, edge_idx: e_b, score });
                            }
                            Some(curr) => {
                                if score > curr.score {
                                    best_cand = Some(CandidateSeamMatch { piece_idx: p_b, edge_idx: e_b, score });
                                }
                            }
                        }
                    }
                }
            }

            best_for_edge[p_a][e_a] = best_cand;
        }
    }

    let mut mutual_pairs = Vec::new();

    // Check reciprocal mutual best-buddies
    for p_a in 0..n {
        for e_a in 0..4 {
            if let Some(ref cand_b) = best_for_edge[p_a][e_a] {
                let p_b = cand_b.piece_idx;
                let e_b = cand_b.edge_idx;

                if p_a < p_b {
                    // Check if piece B's edge e_b also picked piece A's edge e_a as its #1
                    if let Some(ref cand_a) = best_for_edge[p_b][e_b] {
                        if cand_a.piece_idx == p_a && cand_a.edge_idx == e_a {
                            mutual_pairs.push(MutualBestBuddyPair {
                                piece_a_id: pieces[p_a].id.clone(),
                                piece_a_idx: p_a,
                                edge_a_idx: e_a,
                                piece_b_id: pieces[p_b].id.clone(),
                                piece_b_idx: p_b,
                                edge_b_idx: e_b,
                                score: (cand_b.score + cand_a.score) * 0.5,
                            });
                        }
                    }
                }
            }
        }
    }

    mutual_pairs.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    mutual_pairs
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

/// Helper to get the edge pointing in world direction `dir` under clockwise rotation `rot`.
/// dir: 0: North, 1: East, 2: South, 3: West
#[inline]
fn get_oriented_edge<'a>(p: &'a IndexedPieceData, rot: usize, dir: usize) -> &'a IndexedEdgeData {
    let original_idx = (dir + 4 - (rot % 4)) % 4;
    &p.edges[original_idx]
}

/// Helper to find rotation (0..4 CW) where world directions `req_a` and `req_b` are both Flat.
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

/// Helper to find rotation (0..4 CW) where world direction `flat_dir` is Flat.
fn find_border_rotation(p: &IndexedPieceData, flat_dir: usize) -> Option<usize> {
    for rot in 0..4 {
        let edge_idx = (flat_dir + 4 - (rot % 4)) % 4;
        if p.edges[edge_idx].edge_type == EdgeType::Flat {
            return Some(rot);
        }
    }
    None
}

/// Step 6: Closed-Ring Perimeter Loop Optimization
/// Solves the closed perimeter connecting the 4 corners and all border pieces
/// using cascading Steps 1-5 (Mutual Best-Buddies + global 4-side chain constraints).
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
    let total_expected = expected_borders + 4;

    if corners.len() < 4 {
        return SolvedPerimeterResult {
            success: false,
            total_pieces_placed: 0,
            placements: vec![],
            error_message: Some(format!(
                "Need at least 4 corner pieces with 2 flat edges, found {}",
                corners.len()
            )),
        };
    }

    // Step 5: Compute Mutual Best-Buddies among all perimeter pieces to establish high-confidence anchors
    let _buddies = find_mutual_best_buddies(pieces, 0.40);

    // Chaining function along one side of the perimeter
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
                    if let Some(score) = evaluate_candidate_edge_pair(prev_edge, mate_edge, 1.5) {
                        candidates.push((bp, rot, score));
                    }
                }
            }

            if candidates.is_empty() {
                break;
            }

            // Highest compatibility score first
            candidates.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

            let mut chosen = None;
            for &(cand_bp, cand_rot, cand_score) in candidates.iter().take(3) {
                let cand_next_edge = get_oriented_edge(cand_bp, cand_rot, next_edge_dir);
                if step + 1 == count {
                    // Last piece in side chain: check seam closure against target corner edge
                    if let Some(seam_score) = evaluate_candidate_edge_pair(cand_next_edge, corner_target_edge, 1.5) {
                        chosen = Some((cand_bp, cand_rot, cand_score + seam_score));
                        break;
                    }
                } else {
                    // Check if there exists at least one viable successor for the next step
                    let mut has_successor = false;
                    for &next_bp in borders {
                        if used.contains(&next_bp.id) || next_bp.id == cand_bp.id {
                            continue;
                        }
                        if let Some(n_rot) = find_border_rotation(next_bp, flat_dir) {
                            let n_mate = get_oriented_edge(next_bp, n_rot, mate_dir);
                            if evaluate_candidate_edge_pair(cand_next_edge, n_mate, 1.5).is_some() {
                                has_successor = true;
                                break;
                            }
                        }
                    }
                    if has_successor {
                        chosen = Some((cand_bp, cand_rot, cand_score));
                        break;
                    }
                }
            }

            let (bp, rot, score) = chosen.unwrap_or(candidates[0]);

            used.insert(bp.id.clone());
            side_score += 10.0 + score;
            let (r, c) = row_col_fn(step);
            out_placements.push(SolvedBorderPlacement {
                piece_id: bp.id.clone(),
                piece_number: bp.piece_number,
                row: r,
                col: c,
                rotation: rot,
                next_mate_id: None,
                curve_l2_residual: 1.0 - score,
                confidence: (score * 100.0).clamp(0.0, 100.0),
            });

            prev_edge = get_oriented_edge(bp, rot, next_edge_dir);
        }

        let mut seam_closed = false;
        if let Some(seam_score) = evaluate_candidate_edge_pair(prev_edge, corner_target_edge, 1.5) {
            seam_closed = true;
            side_score += 50.0 + seam_score * 10.0;
        }

        (prev_edge, side_score, seam_closed)
    }

    fn try_perimeter_configuration<'a>(
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

        // 1. Corner TL
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

        // 2. Chain Top (col 1 .. cols - 2)
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

        // 3. Corner TR
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

        // 4. Chain Right (row 1 .. rows - 2)
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

        // 5. Corner BR
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

        // 6. Chain Bottom (col cols - 2 down to 1)
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

        // 7. Corner BL
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

        // 8. Chain Left (row rows - 2 down to 1)
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

    for subset in &corner_subsets {
        for perm in &CORNER_PERMUTATIONS {
            let c_tl = subset[perm[0]];
            let c_tr = subset[perm[1]];
            let c_br = subset[perm[2]];
            let c_bl = subset[perm[3]];

            let (plcs, score, closed_seams) = try_perimeter_configuration(
                c_tl, c_tr, c_br, c_bl, &borders, rows, cols,
            );

            if plcs.len() == total_expected && closed_seams == 4 {
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
            }
        }
    }

    let total = best_placements.len();
    SolvedPerimeterResult {
        success: total == total_expected,
        total_pieces_placed: total,
        placements: best_placements,
        error_message: if total < total_expected {
            Some(format!(
                "Solved {} / {} perimeter pieces. Missing {} pieces in current scan pool.",
                total,
                total_expected,
                total_expected.saturating_sub(total)
            ))
        } else {
            None
        },
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

/// Detailed diagnostic inspection result between two pieces
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SingleSeamDetail {
    pub edge_a_idx: usize,
    pub edge_b_idx: usize,
    pub edge_a_type: EdgeType,
    pub edge_b_type: EdgeType,
    pub polarity_compatible: bool,
    pub chord_len_a_mm: f32,
    pub chord_len_b_mm: f32,
    pub chord_diff_mm: f32,
    pub tab_depth_a_mm: f32,
    pub tab_depth_b_mm: f32,
    pub tab_depth_diff_mm: f32,
    pub metric_pass: bool,
    pub l2_curve_distance: f32,
    pub linf_curve_distance: f32,
    pub alignment_shift: i32,
    pub contour_pass: bool,
    pub ink_continuity_cost: f32,
    pub combined_score: f32,
    pub is_mate: bool,
    pub rejection_reason: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DetailedPairwiseInspection {
    pub piece_a_id: String,
    pub piece_b_id: String,
    pub seams: Vec<SingleSeamDetail>,
    pub best_seam: Option<SingleSeamDetail>,
}

/// Computes comprehensive pairwise seam diagnostics between all 16 edge pairings of Piece A and Piece B
pub fn inspect_piece_pair_seams(
    piece_a: &IndexedPieceData,
    piece_b: &IndexedPieceData,
    tolerance_mm: f32,
) -> DetailedPairwiseInspection {
    let mut seams = Vec::new();
    let mut best_seam: Option<SingleSeamDetail> = None;
    let mut highest_score = -1.0f32;

    for e_a in 0..4 {
        let edge_a = &piece_a.edges[e_a];
        for e_b in 0..4 {
            let edge_b = &piece_b.edges[e_b];

            let polarity_compatible = check_step1_edge_topology(edge_a.edge_type, edge_b.edge_type);
            let border_topology_pass = check_step1_border_topology(piece_a, e_a, piece_b, e_b);
            let chord_diff_mm = (edge_a.chord_length_mm - edge_b.chord_length_mm).abs();
            let tab_depth_diff_mm = (edge_a.tab_depth_mm - edge_b.tab_depth_mm).abs();
            let metric_pass = check_step2_metric_tolerances(edge_a, edge_b, tolerance_mm);

            let contour_res = check_step4_subpixel_contour(
                &edge_a.normalized_profile,
                &edge_b.normalized_profile,
                2,
            );
            let contour_pass = contour_res.is_physically_compatible;

            let ink_cost = compute_step3_seam_ink_mgc(
                &edge_a.seam_rgb_samples,
                &edge_b.seam_rgb_samples,
            );
            let has_ink_samples = !edge_a.seam_rgb_samples.is_empty() && !edge_b.seam_rgb_samples.is_empty();
            let ink_pass = !has_ink_samples || ink_cost <= 0.30;

            let is_mate = polarity_compatible && border_topology_pass && metric_pass && contour_pass && ink_pass;

            let mut rejection = None;
            if !polarity_compatible {
                rejection = Some(format!("Incompatible polarity: {:?} and {:?}", edge_a.edge_type, edge_b.edge_type));
            } else if !border_topology_pass {
                rejection = Some("Border pieces cannot mate on interior-facing edges".to_string());
            } else if !metric_pass {
                rejection = Some(format!("Metric tolerance exceeded (chord diff: {:.2}mm, depth diff: {:.2}mm)", chord_diff_mm, tab_depth_diff_mm));
            } else if !contour_pass {
                if contour_res.l2_curve_distance > 0.070 {
                    rejection = Some(format!("Contour L2 mismatch: {:.4} (tolerance <= 0.0700)", contour_res.l2_curve_distance));
                } else {
                    rejection = Some(format!("Max curve collision/gap Linf: {:.4} (tolerance <= 0.1200)", contour_res.linf_curve_distance));
                }
            } else if !ink_pass {
                rejection = Some(format!("Seam ink color discontinuity: MGC cost {:.3} (tolerance <= 0.300)", ink_cost));
            }

            let mut penalty_multiplier = 1.0f32;
            if !polarity_compatible { penalty_multiplier *= 0.10; }
            if !border_topology_pass { penalty_multiplier *= 0.15; }
            if !metric_pass { penalty_multiplier *= 0.35; }
            if !contour_pass { penalty_multiplier *= 0.35; }
            if !ink_pass { penalty_multiplier *= 0.35; }

            let raw_score = if has_ink_samples {
                let ink_factor = (1.0 - (ink_cost / 0.30).min(1.0)).powi(2);
                contour_res.combined_compatibility_score * (0.50 + 0.50 * ink_factor)
            } else {
                contour_res.combined_compatibility_score
            };
            let combined_score = raw_score * penalty_multiplier;

            let detail = SingleSeamDetail {
                edge_a_idx: e_a,
                edge_b_idx: e_b,
                edge_a_type: edge_a.edge_type,
                edge_b_type: edge_b.edge_type,
                polarity_compatible,
                chord_len_a_mm: edge_a.chord_length_mm,
                chord_len_b_mm: edge_b.chord_length_mm,
                chord_diff_mm,
                tab_depth_a_mm: edge_a.tab_depth_mm,
                tab_depth_b_mm: edge_b.tab_depth_mm,
                tab_depth_diff_mm,
                metric_pass,
                l2_curve_distance: contour_res.l2_curve_distance,
                linf_curve_distance: contour_res.linf_curve_distance,
                alignment_shift: contour_res.alignment_shift,
                contour_pass,
                ink_continuity_cost: ink_cost,
                combined_score,
                is_mate,
                rejection_reason: rejection,
            };

            if combined_score > highest_score && is_mate {
                highest_score = combined_score;
                best_seam = Some(detail.clone());
            }

            seams.push(detail);
        }
    }

    // Fallback: If no seam fully passed all gates, pick the best candidate (lowest L2 distance with matching polarity, or lowest L2 overall)
    // so the user can diagnostically see what almost matched and why it failed.
    if best_seam.is_none() {
        best_seam = seams
            .iter()
            .filter(|s| s.polarity_compatible)
            .min_by(|a, b| a.l2_curve_distance.partial_cmp(&b.l2_curve_distance).unwrap_or(std::cmp::Ordering::Equal))
            .cloned()
            .or_else(|| {
                seams
                    .iter()
                    .min_by(|a, b| a.l2_curve_distance.partial_cmp(&b.l2_curve_distance).unwrap_or(std::cmp::Ordering::Equal))
                    .cloned()
            });
    }

    DetailedPairwiseInspection {
        piece_a_id: piece_a.id.clone(),
        piece_b_id: piece_b.id.clone(),
        seams,
        best_seam,
    }
}

/// WASM entry point: Diagnostically inspects all 16 candidate seams between Piece A and Piece B
#[wasm_bindgen]
pub fn inspect_piece_pair_wasm(
    piece_a_json: &str,
    piece_b_json: &str,
    tolerance_mm: f32,
) -> Result<JsValue, JsValue> {
    let piece_a: IndexedPieceData = serde_json::from_str(piece_a_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid piece_a JSON: {}", e)))?;
    let piece_b: IndexedPieceData = serde_json::from_str(piece_b_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid piece_b JSON: {}", e)))?;

    let result = inspect_piece_pair_seams(&piece_a, &piece_b, tolerance_mm);
    serde_wasm_bindgen::to_value(&result)
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

/// Finds Mutual Best-Buddies across the full stored piece inventory
#[wasm_bindgen]
pub fn find_mutual_best_buddies_wasm(
    pieces_json: &str,
    tolerance_mm: f32,
) -> Result<JsValue, JsValue> {
    let pieces: Vec<IndexedPieceData> = serde_json::from_str(pieces_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid pieces JSON: {}", e)))?;

    let result = find_mutual_best_buddies(&pieces, tolerance_mm);
    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

