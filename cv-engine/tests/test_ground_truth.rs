use cv_engine::contour::{self, EdgeType};
use cv_engine::homography::Point2D;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
struct GroundTruthFixture {
    id: String,
    expected_type: String,
    expected_edges: [String; 4],
    /// Human-verified / manually corrected corners (ground truth label)
    corners: [Point2D; 4],
    /// CV-detected corners at freeze time, before any manual adjustment (optional — absent in legacy fixtures)
    #[serde(default)]
    detected_corners: Option<[Point2D; 4]>,
    contour_points: Vec<Point2D>,
}

#[test]
fn test_ground_truth_benchmarks() {
    let gt_dir = Path::new("scans/ground_truth");
    if !gt_dir.exists() {
        println!("No ground truth fixtures yet. Create them using the Web App Labeling tool.");
        return;
    }

    let mut entries: Vec<_> = fs::read_dir(gt_dir)
        .expect("Read ground truth dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "json"))
        .collect();

    entries.sort_by_key(|e| e.file_name());

    if entries.is_empty() {
        println!("No ground truth benchmark files found in scans/ground_truth/.");
        return;
    }

    println!("\n=======================================================");
    println!(" RUNNING GROUND-TRUTH ACCURACY BENCHMARK ({} PIECES)", entries.len());
    println!("=======================================================\n");

    let mut passed = 0;
    let mut total = 0;

    for entry in &entries {
        total += 1;
        let content = fs::read_to_string(entry.path()).expect("Read fixture");
        let fixture: GroundTruthFixture = serde_json::from_str(&content).expect("Parse fixture");

        let detected = contour::partition_edges_and_classify(&fixture.contour_points);
        let piece = match detected {
            Some(p) => p,
            None => {
                println!("FAIL [{}]: NO PIECE DETECTED", fixture.id);
                continue;
            }
        };

        // 1. Check piece type
        let det_type = if piece.is_corner {
            "Corner"
        } else if piece.is_border {
            "Border"
        } else {
            "Interior"
        };

        let type_match = det_type == fixture.expected_type;

        // 2. Check edge sequence (allow 4 cyclic rotations)
        let det_edges: Vec<String> = piece.edges.iter().map(|e| match e.edge_type {
            EdgeType::Flat => "Flat".to_string(),
            EdgeType::Tab => "Tab".to_string(),
            EdgeType::Hole => "Hole".to_string(),
        }).collect();

        let mut edge_match = false;
        for shift in 0..4 {
            let mut matches = true;
            for i in 0..4 {
                if det_edges[(i + shift) % 4] != fixture.expected_edges[i] {
                    matches = false;
                    break;
                }
            }
            if matches {
                edge_match = true;
                break;
            }
        }

        // 3. Corner accuracy: each detected corner should be near one of the ground truth (human-labelled) corners
        let mut max_corner_err = 0.0f32;
        let mut corners_ok = true;
        for c in &piece.corners {
            let min_d = fixture.corners.iter().map(|gt_c| {
                ((gt_c.x - c.x).powi(2) + (gt_c.y - c.y).powi(2)).sqrt()
            }).fold(f32::INFINITY, f32::min);

            if min_d > max_corner_err {
                max_corner_err = min_d;
            }
            if min_d > 7.0 {
                corners_ok = false;
            }
        }

        // 4. If the fixture has detected_corners, compute the CV pre-correction error vs the human label
        //    This lets us track how much the sub-pixel refinement actually helps.
        let detected_err_str = if let Some(ref dc) = fixture.detected_corners {
            let mut max_det_err = 0.0f32;
            for det_c in dc {
                let min_d = fixture.corners.iter().map(|gt_c| {
                    ((gt_c.x - det_c.x).powi(2) + (gt_c.y - det_c.y).powi(2)).sqrt()
                }).fold(f32::INFINITY, f32::min);
                if min_d > max_det_err { max_det_err = min_d; }
            }
            format!(" DetErr={:.1}px", max_det_err)
        } else {
            String::new()
        };

        let is_ok = type_match && edge_match && corners_ok;
        if is_ok {
            passed += 1;
            println!("PASS [{}]: Type={}, Edges={:?}, MaxCornerErr={:.1}px{}",
                fixture.id, det_type, det_edges, max_corner_err, detected_err_str);
        } else {
            println!("FAIL [{}]: Type={}(exp {}), Edges={:?}(exp {:?}), MaxCornerErr={:.1}px{}",
                fixture.id, det_type, fixture.expected_type, det_edges, fixture.expected_edges, max_corner_err, detected_err_str);
        }
    }

    println!("\n-------------------------------------------------------");
    println!(" BENCHMARK SCORE: {} / {} PASSED ({:.1}%)", passed, total, (passed as f32 / total as f32) * 100.0);
    println!("-------------------------------------------------------\n");

    assert_eq!(passed, total, "Some ground-truth fixtures failed benchmark!");
}
