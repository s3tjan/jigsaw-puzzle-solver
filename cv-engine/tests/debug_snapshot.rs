use cv_engine::contour::{self, EdgeType, ScannedPiece};
use cv_engine::homography::Point2D;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Deserialize)]
struct GroundTruthFixture {
    id: String,
    expected_type: String,
    expected_edges: [String; 4],
    corners: [Point2D; 4],
    contour_points: Vec<Point2D>,
}

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

fn partition_edges_fixed(contour: &[Point2D]) -> Option<ScannedPiece> {
    if contour.len() < 40 {
        return None;
    }

    let n = contour.len();
    let mut cx = 0.0f32;
    let mut cy = 0.0f32;
    for p in contour {
        cx += p.x;
        cy += p.y;
    }
    cx /= n as f32;
    cy /= n as f32;

    let r_est = {
        let mut sum_r = 0.0f32;
        for p in contour {
            sum_r += ((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy)).sqrt();
        }
        (sum_r / n as f32).max(10.0)
    };
    let scale_norm = 45.0 / r_est;

    let mut best_line: Option<(usize, usize, f32)> = None;
    let max_span = (n / 3).min(90);
    for span in (40..=max_span).step_by(5) {
        for i in 0..n {
            let mut sum_x = 0.0f32; let mut sum_y = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                sum_x += pt.x; sum_y += pt.y;
            }
            let mx = sum_x / (span as f32); let my = sum_y / (span as f32);
            let mut cxx = 0.0f32; let mut cyy = 0.0f32; let mut cxy = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                let dx = pt.x - mx; let dy = pt.y - my;
                cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
            }
            cxx /= span as f32; cyy /= span as f32; cxy /= span as f32;
            let tr = cxx + cyy;
            let det = cxx * cyy - cxy * cxy;
            let diff = (tr * tr - 4.0 * det).max(0.0).sqrt();
            let std_res = (0.5 * (tr - diff)).max(0.0).sqrt();

            let p0 = contour[i];
            let p1 = contour[(i + span) % n];
            let chord = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt();
            if std_res < 0.60 && chord > 42.0 {
                if best_line.is_none() || span > best_line.unwrap().0 {
                    let angle = (p1.y - p0.y).atan2(p1.x - p0.x);
                    best_line = Some((span, i, angle));
                }
            }
        }
    }

    let mut segments: Vec<(f32, f32)> = Vec::new();
    for &span in &[16usize, 20, 24] {
        if span >= n { continue; }
        for i in (0..n).step_by(2) {
            let mut sum_x = 0.0f32; let mut sum_y = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                sum_x += pt.x; sum_y += pt.y;
            }
            let mx = sum_x / (span as f32); let my = sum_y / (span as f32);
            let mut cxx = 0.0f32; let mut cyy = 0.0f32; let mut cxy = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                let dx = pt.x - mx; let dy = pt.y - my;
                cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
            }
            cxx /= span as f32; cyy /= span as f32; cxy /= span as f32;
            let tr = cxx + cyy;
            let det = cxx * cyy - cxy * cxy;
            let diff = (tr * tr - 4.0 * det).max(0.0).sqrt();
            let std_res = (0.5 * (tr - diff)).max(0.0).sqrt();

            let p0 = contour[i];
            let p1 = contour[(i + span) % n];
            let chord = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt();
            if std_res < 0.40 && chord > 12.0 {
                let ang = (p1.y - p0.y).atan2(p1.x - p0.x);
                segments.push((ang, chord));
            }
        }
    }

    let candidate_thetas: Vec<f32> = if segments.len() >= 5 {
        let mut angle_bins = [0.0f32; 90];
        for (ang, chord) in &segments {
            let mut deg = ang.to_degrees().rem_euclid(90.0);
            if deg >= 45.0 { deg -= 90.0; }
            let bin_idx = ((deg.round() as i32) + 45).clamp(0, 89) as usize;
            angle_bins[bin_idx] += chord;
        }

        let mut bin_indices: Vec<usize> = (0..90).collect();
        bin_indices.sort_by(|&a, &b| angle_bins[b].partial_cmp(&angle_bins[a]).unwrap_or(std::cmp::Ordering::Equal));

        let best_bin1 = bin_indices[0];
        let t1 = ((best_bin1 as f32 - 45.0)).to_radians();

        let mut best_bin2 = None;
        for &b in &bin_indices[1..] {
            if angle_bins[b] < angle_bins[best_bin1] * 0.25 { break; }
            let diff = (b as i32 - best_bin1 as i32).abs();
            if diff >= 20 && diff <= 70 {
                best_bin2 = Some(b);
                break;
            }
        }

        if let Some(b2) = best_bin2 {
            let t2 = ((b2 as f32 - 45.0)).to_radians();
            vec![t1, t2]
        } else {
            vec![t1]
        }
    } else {
        let mut cov_xx = 0.0f32; let mut cov_xy = 0.0f32; let mut cov_yy = 0.0f32;
        for p in contour {
            let dx = p.x - cx; let dy = p.y - cy;
            cov_xx += dx * dx; cov_xy += dx * dy; cov_yy += dy * dy;
        }
        let pca_t = 0.5 * (2.0 * cov_xy).atan2(cov_xx - cov_yy);
        vec![pca_t]
    };

    let k_span = 8;
    let mut best_global_quad = None;
    let mut best_global_score = -1e9f32;
    let mut best_chosen_theta = candidate_thetas[0];

    for &cand_t in &candidate_thetas {
        let mut theta = cand_t;
        while theta <= -std::f32::consts::FRAC_PI_4 {
            theta += std::f32::consts::FRAC_PI_2;
        }
        while theta > std::f32::consts::FRAC_PI_4 {
            theta -= std::f32::consts::FRAC_PI_2;
        }
        let cos_t = theta.cos();
        let sin_t = theta.sin();

        let mut corner_scores = vec![0.0f32; n];
        for i in 0..n {
            let prev = contour[(i as i32 - k_span).rem_euclid(n as i32) as usize];
            let curr = contour[i];
            let next = contour[(i as i32 + k_span).rem_euclid(n as i32) as usize];

            let v1x = curr.x - prev.x; let v1y = curr.y - prev.y;
            let v2x = next.x - curr.x; let v2y = next.y - curr.y;

            let len1 = (v1x * v1x + v1y * v1y).sqrt().max(1e-4);
            let len2 = (v2x * v2x + v2y * v2y).sqrt().max(1e-4);

            let dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
            let cross = (v1x * v2y - v1y * v2x) / (len1 * len2);

            let dist_c = ((curr.x - cx) * (curr.x - cx) + (curr.y - cy) * (curr.y - cy)).sqrt();

            let dx = curr.x - cx;
            let dy = curr.y - cy;
            let u = (dx * cos_t + dy * sin_t).abs();
            let v = (-dx * sin_t + dy * cos_t).abs();

            let ratio = (u.min(v) / u.max(v).max(1e-3)).min(1.0);
            let diagonal_balance = ratio.powf(2.0);

            let convexity = cross.max(0.0);
            let sharpness = (1.0 - dot).max(0.0);
            corner_scores[i] = (dist_c * scale_norm) * diagonal_balance * (1.0 + convexity * 2.0 + sharpness * 1.5);
        }

        let mut q_cands: [Vec<(usize, f32)>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        for (i, p) in contour.iter().enumerate() {
            let dx = p.x - cx;
            let dy = p.y - cy;
            let u = dx * cos_t + dy * sin_t;
            let v = -dx * sin_t + dy * cos_t;

            let q = if u < 0.0 && v < 0.0 { 0 }
                    else if u >= 0.0 && v < 0.0 { 1 }
                    else if u >= 0.0 && v >= 0.0 { 2 }
                    else { 3 };

            q_cands[q].push((i, corner_scores[i]));
        }

        for q in 0..4 {
            q_cands[q].sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let mut filtered = Vec::with_capacity(4);
            for &(idx, sc) in &q_cands[q] {
                let too_close = filtered.iter().any(|&(f_idx, _)| {
                    let dist_idx = ((idx as i32 - f_idx as i32).abs() as usize).min(n - (idx as i32 - f_idx as i32).abs() as usize);
                    dist_idx < 15
                });
                if !too_close {
                    filtered.push((idx, sc));
                    if filtered.len() >= 4 { break; }
                }
            }
            q_cands[q] = filtered;
        }

        if q_cands[0].is_empty() || q_cands[1].is_empty() || q_cands[2].is_empty() || q_cands[3].is_empty() {
            continue;
        }

        for &(c0_idx, sc0) in &q_cands[0] {
            let p0 = contour[c0_idx];
            for &(c1_idx, sc1) in &q_cands[1] {
                let p1 = contour[c1_idx];
                for &(c2_idx, sc2) in &q_cands[2] {
                    let p2 = contour[c2_idx];
                    for &(c3_idx, sc3) in &q_cands[3] {
                        let p3 = contour[c3_idx];

                        let mid_x_diff = (p0.x + p2.x) - (p1.x + p3.x);
                        let mid_y_diff = (p0.y + p2.y) - (p1.y + p3.y);
                        let mid_err = (mid_x_diff * 0.5 * mid_x_diff * 0.5 + mid_y_diff * 0.5 * mid_y_diff * 0.5).sqrt() * scale_norm;

                        let d01 = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt() * scale_norm;
                        let d23 = ((p3.x - p2.x).powi(2) + (p3.y - p2.y).powi(2)).sqrt() * scale_norm;
                        let d12 = ((p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2)).sqrt() * scale_norm;
                        let d30 = ((p0.x - p3.x).powi(2) + (p0.y - p3.y).powi(2)).sqrt() * scale_norm;

                        let edge_diff = (d01 - d23).abs() + (d12 - d30).abs();

                        // Check tab-cut penalty: if chord cuts through a tab, penalize heavily
                        let quad_pts = [p0, p1, p2, p3];
                        let quad_indices = [c0_idx, c1_idx, c2_idx, c3_idx];
                        let mut tab_cut_penalty = 0.0f32;

                        for e in 0..4 {
                            let s_i = quad_indices[e];
                            let e_i = quad_indices[(e + 1) % 4];
                            let ps = quad_pts[e];
                            let pe = quad_pts[(e + 1) % 4];

                            let b_dx = pe.x - ps.x; let b_dy = pe.y - ps.y;
                            let b_len = (b_dx * b_dx + b_dy * b_dy).sqrt().max(1.0);

                            let mut curr_idx = (s_i + 1) % n;
                            let mut has_pos = false;
                            let mut has_neg = false;

                            while curr_idx != e_i {
                                let pt = contour[curr_idx];
                                let dist = ((pt.x - ps.x) * b_dy - (pt.y - ps.y) * b_dx) / b_len;
                                if dist > 6.0 { has_pos = true; }
                                if dist < -6.0 { has_neg = true; }
                                curr_idx = (curr_idx + 1) % n;
                            }

                            if has_pos && has_neg {
                                tab_cut_penalty += 300.0;
                            }
                        }

                        let total_sc = (sc0 + sc1 + sc2 + sc3) - (mid_err * 6.0) - (edge_diff * 1.5) - tab_cut_penalty;

                        if total_sc > best_global_score {
                            best_global_score = total_sc;
                            best_global_quad = Some([c0_idx, c1_idx, c2_idx, c3_idx]);
                            best_chosen_theta = theta;
                        }
                    }
                }
            }
        }
    }

    let best_q_idx = best_global_quad?;
    let theta = best_chosen_theta;

    let corners = [
        contour[best_q_idx[0]],
        contour[best_q_idx[1]],
        contour[best_q_idx[2]],
        contour[best_q_idx[3]],
    ];

    let mut edges_vec = Vec::with_capacity(4);
    for e in 0..4 {
        let start_i = best_q_idx[e];
        let end_i = best_q_idx[(e + 1) % 4];

        let mut samples = Vec::new();
        let mut curr = start_i;
        while curr != end_i {
            samples.push(contour[curr]);
            curr = (curr + 1) % n;
        }
        samples.push(contour[end_i]);

        let p_start = contour[start_i];
        let p_end = contour[end_i];
        let base_dx = p_end.x - p_start.x;
        let base_dy = p_end.y - p_start.y;
        let base_len = (base_dx * base_dx + base_dy * base_dy).sqrt().max(1.0);

        let mut max_signed_dist: f32 = 0.0;
        for s in &samples {
            let dist = ((s.x - p_start.x) * base_dy - (s.y - p_start.y) * base_dx) / base_len;
            if dist.abs() > max_signed_dist.abs() {
                max_signed_dist = dist;
            }
        }

        let mut norm_profile = Vec::with_capacity(100);
        let n_s = samples.len();
        for k in 0..100 {
            let t = k as f32 / 99.0;
            let sample_idx = ((t * (n_s - 1) as f32).round() as usize).min(n_s - 1);
            let s = samples[sample_idx];
            let dist_to_chord = ((s.x - p_start.x) * base_dy - (s.y - p_start.y) * base_dx) / base_len;
            norm_profile.push(dist_to_chord / base_len);
        }

        let mut fourier = [0.0f32; 16];
        for k in 1..=16 {
            let mut re = 0.0f32; let mut im = 0.0f32;
            for (m, &val) in norm_profile.iter().enumerate() {
                let angle = 2.0 * std::f32::consts::PI * (k as f32) * (m as f32) / 100.0;
                re += val * angle.cos();
                im -= val * angle.sin();
            }
            fourier[k - 1] = (re * re + im * im).sqrt() / 100.0;
        }

        edges_vec.push(contour::PieceEdge {
            edge_type: EdgeType::Tab,
            start_corner: p_start,
            end_corner: p_end,
            curvature_depth: max_signed_dist,
            curve_samples: samples,
            normalized_profile: norm_profile,
            fourier_descriptor: fourier,
        });
    }

    let mut scores: [(usize, f32); 4] = [(0, 0.0), (1, 0.0), (2, 0.0), (3, 0.0)];
    for (i, edge) in edges_vec.iter().enumerate() {
        let b_dx = edge.end_corner.x - edge.start_corner.x;
        let b_dy = edge.end_corner.y - edge.start_corner.y;
        let b_len = (b_dx * b_dx + b_dy * b_dy).sqrt().max(1.0);
        let rel_d = edge.curvature_depth.abs() / b_len;

        let n_s = edge.curve_samples.len().max(1) as f32;
        let mut sum_d = 0.0f32;
        let mut sum_d2 = 0.0f32;
        for s in &edge.curve_samples {
            let d = ((s.x - edge.start_corner.x) * b_dy - (s.y - edge.start_corner.y) * b_dx) / b_len;
            sum_d += d;
            sum_d2 += d * d;
        }
        let mean = sum_d / n_s;
        let std_dev = (sum_d2 / n_s - mean * mean).max(0.0).sqrt();

        let s = rel_d * 10.0 + std_dev;
        scores[i] = (i, s);
    }

    // FIX TYPO HERE: sort by b.1 vs a.1
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let has_straight_line = best_line.is_some();
    let mut is_flat = [false; 4];
    let s0 = scores[0].1;
    let s1 = scores[1].1;
    let s2 = scores[2].1;
    let s3 = scores[3].1;

    if has_straight_line {
        if s0 < 8.8 && (s3 - s0 >= 1.8 || s0 < 4.0) {
            is_flat[scores[0].0] = true;
        }
        if is_flat[scores[0].0] && s1 < 8.8 && (s2 - s1 >= 1.2 || s1 < 4.0) {
            is_flat[scores[1].0] = true;
        }
    } else {
        if s0 < 4.0 {
            is_flat[scores[0].0] = true;
        }
    }

    for (i, edge) in edges_vec.iter_mut().enumerate() {
        if is_flat[i] {
            edge.edge_type = EdgeType::Flat;
        } else {
            let mid_x = (edge.start_corner.x + edge.end_corner.x) * 0.5;
            let mid_y = (edge.start_corner.y + edge.end_corner.y) * 0.5;
            let center_dx = cx - mid_x;
            let center_dy = cy - mid_y;
            let base_dx = edge.end_corner.x - edge.start_corner.x;
            let base_dy = edge.end_corner.y - edge.start_corner.y;
            let base_len = (base_dx * base_dx + base_dy * base_dy).sqrt().max(1.0);
            let center_signed_dist = (center_dx * base_dy - center_dy * base_dx) / base_len;

            if (edge.curvature_depth * center_signed_dist) > 0.0 {
                edge.edge_type = EdgeType::Hole;
            } else {
                edge.edge_type = EdgeType::Tab;
            }
        }
    }

    let flat_count = edges_vec.iter().filter(|e| e.edge_type == EdgeType::Flat).count();
    let is_corner = flat_count == 2;
    let is_border = flat_count == 1;

    let edges = [
        edges_vec[0].clone(),
        edges_vec[1].clone(),
        edges_vec[2].clone(),
        edges_vec[3].clone(),
    ];

    let canonical_theta = if theta < 0.0 { theta + std::f32::consts::PI } else { theta };

    Some(ScannedPiece {
        center: Point2D { x: cx, y: cy },
        rotation_angle_rad: canonical_theta,
        bounding_width: (corners[1].x - corners[0].x).abs().max((corners[2].x - corners[3].x).abs()),
        bounding_height: (corners[3].y - corners[0].y).abs().max((corners[2].y - corners[1].y).abs()),
        perimeter_length: contour.len() as f32,
        corners,
        edges,
        contour_points: contour.to_vec(),
        is_corner,
        is_border,
    })
}

fn min_any_winding_err(detected: &[Point2D; 4], gt: &[Point2D; 4]) -> f32 {
    let mut min_err = f32::INFINITY;
    for shift in 0..4 {
        let mut max_err = 0.0f32;
        for i in 0..4 {
            let det_c = detected[(i + shift) % 4];
            let gt_c = gt[i];
            let d = ((gt_c.x - det_c.x).powi(2) + (gt_c.y - det_c.y).powi(2)).sqrt();
            if d > max_err { max_err = d; }
        }
        if max_err < min_err { min_err = max_err; }
    }
    for shift in 0..4 {
        let mut max_err = 0.0f32;
        for i in 0..4 {
            let det_c = detected[(4 - i + shift) % 4];
            let gt_c = gt[i];
            let d = ((gt_c.x - det_c.x).powi(2) + (gt_c.y - det_c.y).powi(2)).sqrt();
            if d > max_err { max_err = d; }
        }
        if max_err < min_err { min_err = max_err; }
    }
    min_err
}

#[test]
fn test_fixed_partition_all() {
    let gt_dir = Path::new("scans/ground_truth");
    if gt_dir.exists() {
        let entries: Vec<_> = fs::read_dir(gt_dir)
            .expect("Read gt dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "json"))
            .collect();

        let mut passed = 0;
        let total = entries.len();
        for entry in &entries {
            let content = fs::read_to_string(entry.path()).expect("Read fixture");
            let fixture: GroundTruthFixture = serde_json::from_str(&content).expect("Parse fixture");
            let detected = contour::partition_edges_and_classify(&fixture.contour_points);

            if let Some(piece) = detected {
                let err = min_any_winding_err(&piece.corners, &fixture.corners);
                let det_type = if piece.is_corner { "Corner" } else if piece.is_border { "Border" } else { "Interior" };
                let type_match = det_type == fixture.expected_type;

                if err <= 7.0 && type_match {
                    passed += 1;
                } else {
                    println!("GT FAIL [{}]: type_match={}, err={:.1}px", fixture.id, type_match, err);
                    println!("  GT corners:       {:?}", fixture.corners);
                    println!("  Detected corners: {:?}", piece.corners);
                }
            } else {
                println!("GT FAIL [{}]: NO PIECE DETECTED", fixture.id);
            }
        }
        println!("\nFIXED PARTITIONER ON GROUND TRUTH: {} / {} PASSED ({:.1}%)\n",
            passed, total, (passed as f32 / total as f32) * 100.0);
    }

    let scans_dir = Path::new("scans");
    if scans_dir.exists() {
        let entries: Vec<_> = fs::read_dir(scans_dir)
            .expect("Read scans dir")
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("piece_snapshot_") && name.ends_with(".json")
            })
            .collect();

        println!("--- SNAPSHOT EVALUATION ---");
        for entry in &entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let content = fs::read_to_string(entry.path()).expect("Read fixture");
            let fixture: SnapshotFixture = match serde_json::from_str(&content) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let contour = &fixture.piece.contour_points;
            let n = contour.len();
            let mut cx = 0.0f32; let mut cy = 0.0f32;
            for p in contour { cx += p.x; cy += p.y; }
            cx /= n as f32; cy /= n as f32;
            let mut cov_xx = 0.0f32; let mut cov_xy = 0.0f32; let mut cov_yy = 0.0f32;
            for p in contour {
                let dx = p.x - cx; let dy = p.y - cy;
                cov_xx += dx * dx; cov_xy += dx * dy; cov_yy += dy * dy;
            }
            let tr = cov_xx + cov_yy;
            let det = cov_xx * cov_yy - cov_xy * cov_xy;
            let diff = (tr * tr - 4.0 * det).max(0.0).sqrt();
            let l1 = 0.5 * (tr + diff);
            let l2 = (0.5 * (tr - diff)).max(1e-3);
            let pca_aspect = (l1 / l2).sqrt();

            let detected = contour::partition_edges_and_classify(contour);
            if let Some(piece) = detected {
                let err = min_any_winding_err(&piece.corners, &fixture.piece.corners);
                let det_type = if piece.is_corner { "Corner" } else if piece.is_border { "Border" } else { "Interior" };
                let exp_type = if fixture.piece.is_corner { "Corner" } else if fixture.piece.is_border { "Border" } else { "Interior" };
                println!("SNAP [{}]: pca_aspect={:.2}, det_type={}(exp={}), corner_err={:.1}px",
                    name, pca_aspect, det_type, exp_type, err);
                if name.contains("1790636311225") {
                    println!("   CONTOUR LEN: {}", contour.len());
                    println!("   SAVED CORNERS: {:?}", fixture.piece.corners);
                    println!("   DETECTED CORNERS: {:?}", piece.corners);
                    println!("   IS_CORNER={}, IS_BORDER={}", piece.is_corner, piece.is_border);
                    for (i, e) in piece.edges.iter().enumerate() {
                        println!("   Edge {}: type={:?}, depth={:.1}", i, e.edge_type, e.curvature_depth);
                    }
                }
            }
        }
    }
}
