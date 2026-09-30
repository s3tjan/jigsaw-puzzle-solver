use cv_engine::contour;
use cv_engine::homography::Point2D;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[allow(dead_code)]
#[derive(Deserialize)]
struct GroundTruthFixture {
    id: String,
    expected_type: String,
    expected_edges: [String; 4],
    corners: [Point2D; 4],
    #[serde(default)]
    detected_corners: Option<[Point2D; 4]>,
    contour_points: Vec<Point2D>,
}

fn calculate_contour_roughness(points: &[Point2D]) -> (f32, f32) {
    let n = points.len();
    if n < 3 {
        return (0.0, 0.0);
    }
    let mut sum_d2 = 0.0f32;
    let mut max_d2 = 0.0f32;
    for i in 0..n {
        let p_prev = points[(i + n - 1) % n];
        let p_curr = points[i];
        let p_next = points[(i + 1) % n];

        let d2x = p_next.x - 2.0 * p_curr.x + p_prev.x;
        let d2y = p_next.y - 2.0 * p_curr.y + p_prev.y;
        let d2 = (d2x * d2x + d2y * d2y).sqrt();

        sum_d2 += d2;
        if d2 > max_d2 {
            max_d2 = d2;
        }
    }
    (sum_d2 / n as f32, max_d2)
}

/// Test 1: Baseline consistency across piece edge endpoints and corners.
/// Edge start_corner and end_corner must match the piece's corner vertices.
#[test]
fn test_edge_endpoint_corner_consistency() {
    let archive_dir = Path::new("datasets/archive/v1");
    if !archive_dir.exists() {
        return;
    }

    let entries: Vec<_> = fs::read_dir(archive_dir)
        .expect("Read archive dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "json"))
        .collect();

    let mut inconsistent_count = 0;
    let mut checked_pieces = 0;

    for entry in &entries {
        let content = fs::read_to_string(entry.path()).expect("Read fixture");
        let fixture: GroundTruthFixture = serde_json::from_str(&content).expect("Parse fixture");

        if let Some(piece) = contour::partition_edges_and_classify(&fixture.contour_points) {
            checked_pieces += 1;
            for i in 0..4 {
                let expected_start = piece.corners[i];
                let expected_end = piece.corners[(i + 1) % 4];
                let edge = &piece.edges[i];

                let start_dist = ((edge.start_corner.x - expected_start.x).powi(2)
                    + (edge.start_corner.y - expected_start.y).powi(2))
                .sqrt();
                let end_dist = ((edge.end_corner.x - expected_end.x).powi(2)
                    + (edge.end_corner.y - expected_end.y).powi(2))
                .sqrt();

                if start_dist > 1e-3 || end_dist > 1e-3 {
                    inconsistent_count += 1;
                }
            }
        }
    }

    println!(
        "Edge-corner endpoint consistency: {} discrepancies across {} pieces",
        inconsistent_count, checked_pieces
    );

    // This assertion fails because edges currently keep unrefined raw contour points as start/end
    // while piece.corners underwent sub-pixel line-intersection refinement!
    assert_eq!(
        inconsistent_count, 0,
        "PieceEdge start/end corners diverge from piece.corners, causing baseline wobble!"
    );
}

/// Test 2: Contour smoothness and local curvature noise threshold.
/// Contours traced from binarized masks must maintain continuous sub-pixel smoothness.
#[test]
fn test_contour_smoothness_and_wobble_budget() {
    let archive_dir = Path::new("datasets/archive/v1");
    if !archive_dir.exists() {
        return;
    }

    let entries: Vec<_> = fs::read_dir(archive_dir)
        .expect("Read archive dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "json"))
        .collect();

    let mut rough_contours = 0;
    let total = entries.len();

    // Required smoothness budget for curve-matching (Phase 6):
    // Average 2nd difference (local directional jerk) should be below 0.11px.
    // Three-pass Gaussian smoothing eliminates discrete integer raster staircases.
    let max_allowed_avg_roughness = 0.11f32;

    for entry in &entries {
        let content = fs::read_to_string(entry.path()).expect("Read fixture");
        let fixture: GroundTruthFixture = serde_json::from_str(&content).expect("Parse fixture");

        let smoothed = contour::smooth_contour_points(&fixture.contour_points);
        let (avg_roughness, _max_roughness) = calculate_contour_roughness(&smoothed);

        if avg_roughness > max_allowed_avg_roughness {
            rough_contours += 1;
        }
    }

    println!(
        "Contour smoothness audit: {} / {} contours exceed the 0.11px roughness threshold",
        rough_contours, total
    );

    assert_eq!(
        rough_contours, 0,
        "Contours have step noise exceeding the smoothness budget!"
    );
}
