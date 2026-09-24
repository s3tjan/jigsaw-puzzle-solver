use crate::homography::Point2D;
use crate::contour::{PieceEdge, EdgeType};

/// Evaluates geometric interlocking compatibility between Edge A of Piece 1 and Edge B of Piece 2
/// Returns a compatibility score in [0.0, 1.0] (1.0 = perfect mathematical lock).
pub fn match_edge_curves(edge_a: &PieceEdge, edge_b: &PieceEdge) -> f32 {
    // Fundamental topological requirement: Male Tab must mate with Female Hole (or vice-versa)
    let is_compatible_types = match (edge_a.edge_type, edge_b.edge_type) {
        (EdgeType::Tab, EdgeType::Hole) => true,
        (EdgeType::Hole, EdgeType::Tab) => true,
        (EdgeType::Flat, _) => false,
        (_, EdgeType::Flat) => false,
        (EdgeType::Tab, EdgeType::Tab) => false,
        (EdgeType::Hole, EdgeType::Hole) => false,
    };

    if !is_compatible_types {
        return 0.0;
    }

    // Depth check: The tab height must match the hole depth within ~15%
    let depth_a = edge_a.curvature_depth.abs();
    let depth_b = edge_b.curvature_depth.abs();
    let depth_diff = (depth_a - depth_b).abs() / depth_a.max(depth_b).max(1.0);

    if depth_diff > 0.25 {
        return 0.0; // Physically impossible fit
    }

    // Normalized Turn-Angle / Discrete Curve Correlation:
    // Compare 20 evenly sampled points along both curves
    let num_samples = 20;
    let samples_a = resample_curve(&edge_a.curve_samples, num_samples);
    // Reverse edge B because pieces touch head-to-tail along their shared boundary
    let mut reversed_b = edge_b.curve_samples.clone();
    reversed_b.reverse();
    let samples_b = resample_curve(&reversed_b, num_samples);

    let mut sum_sq_error: f32 = 0.0;
    for i in 0..num_samples {
        let dx = samples_a[i].x - samples_b[i].x;
        let dy = samples_a[i].y - samples_b[i].y;
        sum_sq_error += dx * dx + dy * dy;
    }

    let rms_error = (sum_sq_error / num_samples as f32).sqrt();

    // Convert RMS pixel error into smooth 0.0 - 1.0 confidence score
    // 0px error = 1.0, 10px error = ~0.36
    (-rms_error / 8.0).exp()
}

/// Uniformly resamples a 2D polyline curve into N equidistant points
fn resample_curve(points: &[Point2D], target_count: usize) -> Vec<Point2D> {
    if points.is_empty() || target_count == 0 {
        return Vec::new();
    }
    if points.len() == 1 {
        return vec![points[0]; target_count];
    }

    // Compute cumulative arc length
    let mut cum_dist = Vec::with_capacity(points.len());
    cum_dist.push(0.0f32);
    for i in 1..points.len() {
        let dx = points[i].x - points[i - 1].x;
        let dy = points[i].y - points[i - 1].y;
        let d = (dx * dx + dy * dy).sqrt();
        cum_dist.push(cum_dist[i - 1] + d);
    }

    let total_len = *cum_dist.last().unwrap();
    if total_len < 1e-4 {
        return vec![points[0]; target_count];
    }

    let step = total_len / (target_count - 1) as f32;
    let mut resampled = Vec::with_capacity(target_count);

    let mut seg = 0;
    for i in 0..target_count {
        let target_dist = i as f32 * step;
        while seg < cum_dist.len() - 2 && cum_dist[seg + 1] < target_dist {
            seg += 1;
        }

        let seg_start_d = cum_dist[seg];
        let seg_end_d = cum_dist[seg + 1];
        let seg_len = (seg_end_d - seg_start_d).max(1e-4);
        let t = ((target_dist - seg_start_d) / seg_len).clamp(0.0, 1.0);

        let p0 = points[seg];
        let p1 = points[seg + 1];

        resampled.push(Point2D {
            x: p0.x + t * (p1.x - p0.x),
            y: p0.y + t * (p1.y - p0.y),
        });
    }

    resampled
}
