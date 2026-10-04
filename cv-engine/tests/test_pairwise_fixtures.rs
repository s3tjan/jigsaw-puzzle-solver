use cv_engine::matcher::{inspect_piece_pair_seams, IndexedPieceData};
use std::fs::File;
use std::io::BufReader;

#[test]
fn test_saved_pair_fixtures_pass_mating() {
    // 1. True Mate: Piece 1 (E4) ↔ Piece 2 (E2) (pair_gt_1791060625423.json)
    {
        let path = "datasets/ground_truth/pairs/pair_gt_1791060625423.json";
        let file = File::open(path).unwrap_or_else(|e| panic!("Failed to open fixture {}: {}", path, e));
        let reader = BufReader::new(file);
        let fixture: serde_json::Value = serde_json::from_reader(reader).expect("Invalid JSON in pair fixture");

        let piece_a: IndexedPieceData = serde_json::from_value(fixture["piece_a_data"].clone())
            .expect("Failed to deserialize piece_a_data");
        let piece_b: IndexedPieceData = serde_json::from_value(fixture["piece_b_data"].clone())
            .expect("Failed to deserialize piece_b_data");

        let inspection = inspect_piece_pair_seams(&piece_a, &piece_b, 1.5);
        let best = inspection.best_seam.as_ref().expect("best_seam must exist");
        println!(
            "True Fixture 1: Piece #{} [E{}] ↔ Piece #{} [E{}] -> is_mate={}, chord_diff={:.2}mm, L2={:.4}, MGC={:.3}, score={:.1}%",
            piece_a.piece_number,
            best.edge_a_idx + 1,
            piece_b.piece_number,
            best.edge_b_idx + 1,
            best.is_mate,
            best.chord_diff_mm,
            best.l2_curve_distance,
            best.ink_continuity_cost,
            best.combined_score * 100.0
        );

        let edge_a = &piece_a.edges[3];
        let edge_b = &piece_b.edges[1];
        let n = edge_a.seam_rgb_samples.len().min(edge_b.seam_rgb_samples.len());
        let mut sum_delta_e = 0.0f32;
        let mut sum_grad_sq = 0.0f32;
        let mut grad_count = 0;
        for k in 0..n {
            let b_idx = n - 1 - k;
            let lab_a = cv_engine::poster::rgb_to_cielab(edge_a.seam_rgb_samples[k][0], edge_a.seam_rgb_samples[k][1], edge_a.seam_rgb_samples[k][2]);
            let lab_b = cv_engine::poster::rgb_to_cielab(edge_b.seam_rgb_samples[b_idx][0], edge_b.seam_rgb_samples[b_idx][1], edge_b.seam_rgb_samples[b_idx][2]);
            let d_l = lab_a[0] - lab_b[0];
            let d_a = lab_a[1] - lab_b[1];
            let d_b = lab_a[2] - lab_b[2];
            sum_delta_e += (d_l * d_l + d_a * d_a + d_b * d_b).sqrt();
            if k + 1 < n {
                let next_b_idx = n - 1 - (k + 1);
                let n_lab_a = cv_engine::poster::rgb_to_cielab(edge_a.seam_rgb_samples[k+1][0], edge_a.seam_rgb_samples[k+1][1], edge_a.seam_rgb_samples[k+1][2]);
                let n_lab_b = cv_engine::poster::rgb_to_cielab(edge_b.seam_rgb_samples[next_b_idx][0], edge_b.seam_rgb_samples[next_b_idx][1], edge_b.seam_rgb_samples[next_b_idx][2]);
                let ga = [n_lab_a[0] - lab_a[0], n_lab_a[1] - lab_a[1], n_lab_a[2] - lab_a[2]];
                let gb = [lab_b[0] - n_lab_b[0], lab_b[1] - n_lab_b[1], lab_b[2] - n_lab_b[2]];
                let d_g = [ga[0] - gb[0], ga[1] - gb[1], ga[2] - gb[2]];
                sum_grad_sq += d_g[0]*d_g[0] + d_g[1]*d_g[1] + d_g[2]*d_g[2];
                grad_count += 1;
            }
        }
        println!("True 1: mean_de={:.1}, mean_grad={:.1}", sum_delta_e / n as f32, (sum_grad_sq / grad_count as f32).sqrt());

        assert!(best.is_mate, "Best seam for Piece 1 ↔ Piece 2 must pass as a genuine mate!");
        assert_eq!(best.edge_a_idx, 3, "Piece 1 edge must be edge 3 (E4)");
        assert_eq!(best.edge_b_idx, 1, "Piece 2 edge must be edge 1 (E2)");
        assert!(best.chord_diff_mm < 1.0, "Chord diff along true seam is < 1.0mm, got {}", best.chord_diff_mm);
        assert!(best.ink_continuity_cost <= 0.30, "MGC ink cost for true mate must be <= 0.30, got {}", best.ink_continuity_cost);

        let edge_a = &piece_a.edges[3];
        let edge_b = &piece_b.edges[1];
        let n = edge_a.seam_rgb_samples.len().min(edge_b.seam_rgb_samples.len());
        let mut d_es = Vec::new();
        for k in 0..n {
            let b_idx = n - 1 - k;
            let c_a = edge_a.seam_rgb_samples[k];
            let c_b = edge_b.seam_rgb_samples[b_idx];
            if (c_a[0] > 10 || c_a[1] > 10 || c_a[2] > 10) && (c_b[0] > 10 || c_b[1] > 10 || c_b[2] > 10) {
                let lab_a = cv_engine::poster::rgb_to_cielab(c_a[0], c_a[1], c_a[2]);
                let lab_b = cv_engine::poster::rgb_to_cielab(c_b[0], c_b[1], c_b[2]);
                let d_l = lab_a[0] - lab_b[0];
                let d_a = lab_a[1] - lab_b[1];
                let d_b = lab_a[2] - lab_b[2];
                d_es.push((d_l * d_l + d_a * d_a + d_b * d_b).sqrt());
            }
        }
        let mut sorted = d_es.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n_valid = sorted.len();
        let mean_de: f32 = sorted.iter().sum::<f32>() / n_valid as f32;
        let p75_de = sorted[(n_valid as f32 * 0.75) as usize];
        println!("True 1 filtered: count={}, mean_de={:.1}, median={:.1}, p75={:.1}", n_valid, mean_de, sorted[n_valid/2], p75_de);
    }

    // 2. True Mate: Piece 2 (E4) ↔ Piece 3 (E2) (pair_gt_1791060639532.json)
    {
        let path = "datasets/ground_truth/pairs/pair_gt_1791060639532.json";
        let file = File::open(path).unwrap_or_else(|e| panic!("Failed to open fixture {}: {}", path, e));
        let reader = BufReader::new(file);
        let fixture: serde_json::Value = serde_json::from_reader(reader).expect("Invalid JSON in pair fixture");

        let piece_a: IndexedPieceData = serde_json::from_value(fixture["piece_a_data"].clone())
            .expect("Failed to deserialize piece_a_data");
        let piece_b: IndexedPieceData = serde_json::from_value(fixture["piece_b_data"].clone())
            .expect("Failed to deserialize piece_b_data");

        let inspection = inspect_piece_pair_seams(&piece_a, &piece_b, 1.5);
        let best = inspection.best_seam.as_ref().expect("best_seam must exist");
        println!(
            "True Fixture 2: Piece #{} [E{}] ↔ Piece #{} [E{}] -> is_mate={}, chord_diff={:.2}mm, L2={:.4}, MGC={:.3}, score={:.1}%",
            piece_a.piece_number,
            best.edge_a_idx + 1,
            piece_b.piece_number,
            best.edge_b_idx + 1,
            best.is_mate,
            best.chord_diff_mm,
            best.l2_curve_distance,
            best.ink_continuity_cost,
            best.combined_score * 100.0
        );

        assert!(best.is_mate, "Best seam for Piece 2 ↔ Piece 3 must pass as a genuine mate!");
        assert_eq!(best.edge_a_idx, 3, "Piece 2 edge must be edge 3 (E4)");
        assert_eq!(best.edge_b_idx, 1, "Piece 3 edge must be edge 1 (E2)");
        assert!(best.chord_diff_mm < 1.0, "Chord diff along true seam is < 1.0mm, got {}", best.chord_diff_mm);
        assert!(best.ink_continuity_cost <= 0.30, "MGC ink cost for true mate must be <= 0.30, got {}", best.ink_continuity_cost);

        let edge_a = &piece_a.edges[3];
        let edge_b = &piece_b.edges[1];
        let n = edge_a.seam_rgb_samples.len().min(edge_b.seam_rgb_samples.len());
        let mut d_es = Vec::new();
        for k in 0..n {
            let b_idx = n - 1 - k;
            let c_a = edge_a.seam_rgb_samples[k];
            let c_b = edge_b.seam_rgb_samples[b_idx];
            if (c_a[0] > 10 || c_a[1] > 10 || c_a[2] > 10) && (c_b[0] > 10 || c_b[1] > 10 || c_b[2] > 10) {
                let lab_a = cv_engine::poster::rgb_to_cielab(c_a[0], c_a[1], c_a[2]);
                let lab_b = cv_engine::poster::rgb_to_cielab(c_b[0], c_b[1], c_b[2]);
                let d_l = lab_a[0] - lab_b[0];
                let d_a = lab_a[1] - lab_b[1];
                let d_b = lab_a[2] - lab_b[2];
                d_es.push((d_l * d_l + d_a * d_a + d_b * d_b).sqrt());
            }
        }
        let mut sorted = d_es.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n_valid = sorted.len();
        let mean_de: f32 = sorted.iter().sum::<f32>() / n_valid as f32;
        let p75_de = sorted[(n_valid as f32 * 0.75) as usize];
        println!("True 2 filtered: count={}, mean_de={:.1}, median={:.1}, p75={:.1}", n_valid, mean_de, sorted[n_valid/2], p75_de);
    }

    // 3. Negative Fixture: False Mate: Piece 1 (E3) ↔ Piece 3 (E4) (pair_gt_1791060683537.json)
    {
        let path = "datasets/ground_truth/pairs/pair_gt_1791060683537.json";
        let file = File::open(path).unwrap_or_else(|e| panic!("Failed to open fixture {}: {}", path, e));
        let reader = BufReader::new(file);
        let fixture: serde_json::Value = serde_json::from_reader(reader).expect("Invalid JSON in pair fixture");

        let piece_a: IndexedPieceData = serde_json::from_value(fixture["piece_a_data"].clone())
            .expect("Failed to deserialize piece_a_data");
        let piece_b: IndexedPieceData = serde_json::from_value(fixture["piece_b_data"].clone())
            .expect("Failed to deserialize piece_b_data");

        let inspection = inspect_piece_pair_seams(&piece_a, &piece_b, 1.5);
        let target_seam = inspection.seams.iter().find(|s| s.edge_a_idx == 2 && s.edge_b_idx == 3)
            .expect("Seam P1:E3 ↔ P3:E4 must exist in inspection");

        println!(
            "False Fixture: Piece #{} [E{}] ↔ Piece #{} [E{}] -> is_mate={}, chord_diff={:.2}mm, MGC={:.3}, score={:.1}%, rejection={:?}",
            piece_a.piece_number,
            target_seam.edge_a_idx + 1,
            piece_b.piece_number,
            target_seam.edge_b_idx + 1,
            target_seam.is_mate,
            target_seam.chord_diff_mm,
            target_seam.ink_continuity_cost,
            target_seam.combined_score * 100.0,
            target_seam.rejection_reason
        );

        assert!(!target_seam.is_mate, "False mate Piece 1 ↔ Piece 3 MUST be rejected!");
        assert!(!target_seam.metric_pass, "Step 2 metric tolerance MUST fail on false mate (chord diff 3.00mm > 1.5mm)");
        assert!(target_seam.combined_score < 0.20, "Rejected seam score ({:.1}%) must be penalized (< 20%)!", target_seam.combined_score * 100.0);
    }

    // 4. Negative Fixture: False Mate with similar curve geometry: Piece 7 (E2) ↔ Piece 3 (E3) (pair_gt_1791061257647.json)
    {
        let path = "datasets/ground_truth/pairs/pair_gt_1791061257647.json";
        let file = File::open(path).unwrap_or_else(|e| panic!("Failed to open fixture {}: {}", path, e));
        let reader = BufReader::new(file);
        let fixture: serde_json::Value = serde_json::from_reader(reader).expect("Invalid JSON in pair fixture");

        let piece_a: IndexedPieceData = serde_json::from_value(fixture["piece_a_data"].clone())
            .expect("Failed to deserialize piece_a_data");
        let piece_b: IndexedPieceData = serde_json::from_value(fixture["piece_b_data"].clone())
            .expect("Failed to deserialize piece_b_data");

        let inspection = inspect_piece_pair_seams(&piece_a, &piece_b, 1.5);
        let target_seam = inspection.seams.iter().find(|s| s.edge_a_idx == 1 && s.edge_b_idx == 2)
            .expect("Seam P7:E2 ↔ P3:E3 must exist in inspection");

        println!(
            "False Fixture 4: Piece #{} [E{}] ↔ Piece #{} [E{}] -> is_mate={}, chord_diff={:.2}mm, L2={:.4}, MGC={:.3}, score={:.1}%, rejection={:?}",
            piece_a.piece_number,
            target_seam.edge_a_idx + 1,
            piece_b.piece_number,
            target_seam.edge_b_idx + 1,
            target_seam.is_mate,
            target_seam.chord_diff_mm,
            target_seam.l2_curve_distance,
            target_seam.ink_continuity_cost,
            target_seam.combined_score * 100.0,
            target_seam.rejection_reason
        );

        let edge_a = &piece_a.edges[1];
        let edge_b = &piece_b.edges[2];
        let n = edge_a.seam_rgb_samples.len().min(edge_b.seam_rgb_samples.len());
        let mut d_es = Vec::new();
        for k in 0..n {
            let b_idx = n - 1 - k;
            let c_a = edge_a.seam_rgb_samples[k];
            let c_b = edge_b.seam_rgb_samples[b_idx];
            if (c_a[0] > 10 || c_a[1] > 10 || c_a[2] > 10) && (c_b[0] > 10 || c_b[1] > 10 || c_b[2] > 10) {
                let lab_a = cv_engine::poster::rgb_to_cielab(c_a[0], c_a[1], c_a[2]);
                let lab_b = cv_engine::poster::rgb_to_cielab(c_b[0], c_b[1], c_b[2]);
                let d_l = lab_a[0] - lab_b[0];
                let d_a = lab_a[1] - lab_b[1];
                let d_b = lab_a[2] - lab_b[2];
                d_es.push((d_l * d_l + d_a * d_a + d_b * d_b).sqrt());
            }
        }
        let mut sorted = d_es.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n_valid = sorted.len();
        let mean_de: f32 = sorted.iter().sum::<f32>() / n_valid as f32;
        let p75_de = sorted[(n_valid as f32 * 0.75) as usize];
        println!("Fixture 4 filtered: count={}, mean_de={:.1}, median={:.1}, p75={:.1}", n_valid, mean_de, sorted[n_valid/2], p75_de);
        assert!(!target_seam.is_mate, "False mate Piece 7 ↔ Piece 3 MUST be rejected by MGC ink discontinuity!");
        assert!(target_seam.ink_continuity_cost > 0.30, "MGC ink cost for false mate must be > 0.30, got {}", target_seam.ink_continuity_cost);
        assert!(target_seam.combined_score < 0.15, "Score for false mate must be penalized (< 15%), got {:.1}%", target_seam.combined_score * 100.0);
    }

    // 5. Negative Fixture: False Mate: Piece 4 (E3) ↔ Piece 2 (E2) (pair_gt_1791063161419.json)
    {
        let path = "datasets/ground_truth/pairs/pair_gt_1791063161419.json";
        let file = File::open(path).unwrap_or_else(|e| panic!("Failed to open fixture {}: {}", path, e));
        let reader = BufReader::new(file);
        let fixture: serde_json::Value = serde_json::from_reader(reader).expect("Invalid JSON in pair fixture");

        let piece_a: IndexedPieceData = serde_json::from_value(fixture["piece_a_data"].clone())
            .expect("Failed to deserialize piece_a_data");
        let piece_b: IndexedPieceData = serde_json::from_value(fixture["piece_b_data"].clone())
            .expect("Failed to deserialize piece_b_data");

        let inspection = inspect_piece_pair_seams(&piece_a, &piece_b, 1.5);
        let target_seam = inspection.seams.iter().find(|s| s.edge_a_idx == 2 && s.edge_b_idx == 1)
            .expect("Seam P4:E3 ↔ P2:E2 must exist in inspection");

        println!(
            "False Fixture 5: Piece #{} [E{}] ↔ Piece #{} [E{}] -> is_mate={}, chord_diff={:.2}mm, L2={:.4}, MGC={:.3}, score={:.1}%, rejection={:?}",
            piece_a.piece_number,
            target_seam.edge_a_idx + 1,
            piece_b.piece_number,
            target_seam.edge_b_idx + 1,
            target_seam.is_mate,
            target_seam.chord_diff_mm,
            target_seam.l2_curve_distance,
            target_seam.ink_continuity_cost,
            target_seam.combined_score * 100.0,
            target_seam.rejection_reason
        );

        assert!(!target_seam.is_mate, "False mate Piece 4 ↔ Piece 2 MUST be rejected!");
        assert!(target_seam.ink_continuity_cost > 0.30, "Tail-aware MGC cost must exceed 0.30 (got {:.3})", target_seam.ink_continuity_cost);
        assert_eq!(
            target_seam.rejection_reason.as_deref(),
            Some("Seam ink color discontinuity: MGC cost 0.390 (tolerance <= 0.300)"),
            "Rejection reason must identify seam ink color discontinuity"
        );
        assert!(target_seam.combined_score < 0.10, "Score for false mate must be heavily penalized (< 10%), got {:.1}%", target_seam.combined_score * 100.0);
    }
}
