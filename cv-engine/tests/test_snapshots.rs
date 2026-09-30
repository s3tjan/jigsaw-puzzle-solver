use cv_engine::contour::{self, EdgeType};
use cv_engine::homography::Point2D;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
struct PieceData {
    corners: [Point2D; 4],
    contour_points: Vec<Point2D>,
    is_corner: bool,
    is_border: bool,
}

#[derive(Deserialize)]
struct SnapshotFixture {
    piece: PieceData,
}

#[test]
fn test_snapshots_benchmarks() {
    let scans_dir = Path::new("scans");
    if !scans_dir.exists() {
        return;
    }

    let mut entries: Vec<_> = fs::read_dir(scans_dir)
        .expect("Read scans dir")
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.starts_with("piece_snapshot_") && name.ends_with(".json")
        })
        .collect();

    entries.sort_by_key(|e| e.file_name());

    println!("\n=======================================================");
    println!(" SNAPSHOT DIAGNOSTIC BREAKDOWN ({} FILES)", entries.len());
    println!("=======================================================\n");

    for entry in &entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let content = fs::read_to_string(entry.path()).expect("Read fixture");
        let fixture: SnapshotFixture = match serde_json::from_str(&content) {
            Ok(f) => f,
            Err(e) => {
                println!("ERR [{}]: Failed to parse: {}", name, e);
                continue;
            }
        };

        let contour_pts = &fixture.piece.contour_points;
        let detected = contour::partition_edges_and_classify(contour_pts);
        let piece = match detected {
            Some(p) => p,
            None => {
                println!("FAIL [{}]: NO PIECE DETECTED", name);
                continue;
            }
        };

        let det_type = if piece.is_corner { "Corner" } else if piece.is_border { "Border" } else { "Interior" };
        let exp_type = if fixture.piece.is_corner { "Corner" } else if fixture.piece.is_border { "Border" } else { "Interior" };

        let det_edges: Vec<String> = piece.edges.iter().map(|e| match e.edge_type {
            EdgeType::Flat => "Flat".to_string(),
            EdgeType::Tab => "Tab".to_string(),
            EdgeType::Hole => "Hole".to_string(),
        }).collect();

        println!("\n--- {} ---", name);
        println!("  Contour length: {} pts", contour_pts.len());
        println!("  Type: detected={}, saved={}", det_type, exp_type);
        println!("  Edges: {:?}", det_edges);
        println!("  Saved Corners:    {:?}", fixture.piece.corners);
        println!("  Detected Corners: {:?}", piece.corners);

        for (i, dc) in piece.corners.iter().enumerate() {
            let mut min_d = f32::INFINITY;
            let mut best_gt_idx = 0;
            for (gt_i, gt_c) in fixture.piece.corners.iter().enumerate() {
                let d = ((gt_c.x - dc.x).powi(2) + (gt_c.y - dc.y).powi(2)).sqrt();
                if d < min_d {
                    min_d = d;
                    best_gt_idx = gt_i;
                }
            }
            println!("    Corner {}: ({:.1}, {:.1}) -> Closest saved corner {} at {:.1}px",
                i, dc.x, dc.y, best_gt_idx, min_d);
        }
    }
}
