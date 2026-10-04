use crate::contour::{EdgeType, PieceEdge};
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
