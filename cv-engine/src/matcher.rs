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
        if depth_ratio > 0.40 {
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
