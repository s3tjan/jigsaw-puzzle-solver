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

fn evaluate_corners(contour: &[Point2D]) -> Option<[Point2D; 4]> {
    let n = contour.len();
    if n < 40 {
        return None;
    }

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
            sum_r += ((p.x - cx).powi(2) + (p.y - cy).powi(2)).sqrt();
        }
        (sum_r / n as f32).max(10.0)
    };
    let scale_norm = 45.0 / r_est;

    let k_span = (n / 45).max(6).min(14);
    let mut raw_scores = vec![0.0f32; n];

    for i in 0..n {
        let prev = contour[(i as i32 - k_span as i32).rem_euclid(n as i32) as usize];
        let curr = contour[i];
        let next = contour[(i as i32 + k_span as i32).rem_euclid(n as i32) as usize];

        let v1x = curr.x - prev.x;
        let v1y = curr.y - prev.y;
        let v2x = next.x - curr.x;
        let v2y = next.y - curr.y;

        let len1 = (v1x * v1x + v1y * v1y).sqrt().max(1e-4);
        let len2 = (v2x * v2x + v2y * v2y).sqrt().max(1e-4);

        let dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
        let cross = (v1x * v2y - v1y * v2x) / (len1 * len2);

        let dist_c = ((curr.x - cx).powi(2) + (curr.y - cy).powi(2)).sqrt();

        let convexity = cross.max(0.0);
        let sharpness = (1.0 - dot).max(0.0);

        // Aspect-ratio independent corner score
        raw_scores[i] = (dist_c * scale_norm) * (1.0 + convexity * 2.5 + sharpness * 2.0);
    }

    // Collect local maxima candidate peaks
    let mut candidates = Vec::new();
    let window = k_span;
    for i in 0..n {
        let sc = raw_scores[i];
        let mut is_max = true;
        for w in 1..=window {
            let left_sc = raw_scores[(i as i32 - w as i32).rem_euclid(n as i32) as usize];
            let right_sc = raw_scores[(i + w) % n];
            if left_sc > sc || right_sc > sc {
                is_max = false;
                break;
            }
        }
        if is_max && sc > 15.0 {
            candidates.push((i, sc));
        }
    }

    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Filter candidate peaks that are too close along contour
    let mut filtered_cands: Vec<(usize, f32)> = Vec::new();
    let min_dist_idx = n / 12;
    for &(idx, sc) in &candidates {
        let too_close = filtered_cands.iter().any(|&(f_idx, _)| {
            let dist_idx = ((idx as i32 - f_idx as i32).abs() as usize)
                .min(n - (idx as i32 - f_idx as i32).abs() as usize);
            dist_idx < min_dist_idx
        });
        if !too_close {
            filtered_cands.push((idx, sc));
            if filtered_cands.len() >= 16 {
                break;
            }
        }
    }

    if filtered_cands.len() < 4 {
        return None;
    }

    // Sort candidates in cyclic contour order
    filtered_cands.sort_by_key(|c| c.0);
    let c_indices: Vec<usize> = filtered_cands.iter().map(|c| c.0).collect();
    let m = c_indices.len();

    let min_span = n / 8;

    let mut best_quad = [c_indices[0], c_indices[1], c_indices[2], c_indices[3]];
    let mut best_score = -1e9f32;

    for a in 0..m {
        let i0 = c_indices[a];
        let p0 = contour[i0];
        for b in (a + 1)..m {
            let i1 = c_indices[b];
            if i1 - i0 < min_span { continue; }
            let p1 = contour[i1];
            for c in (b + 1)..m {
                let i2 = c_indices[c];
                if i2 - i1 < min_span { continue; }
                let p2 = contour[i2];
                for d in (c + 1)..m {
                    let i3 = c_indices[d];
                    if i3 - i2 < min_span || (i0 + n - i3) < min_span { continue; }
                    let p3 = contour[i3];

                    // Check convex quad winding
                    let e0x = p1.x - p0.x; let e0y = p1.y - p0.y;
                    let e1x = p2.x - p1.x; let e1y = p2.y - p1.y;
                    let e2x = p3.x - p2.x; let e2y = p3.y - p2.y;
                    let e3x = p0.x - p3.x; let e3y = p0.y - p3.y;

                    let cp0 = e0x * e1y - e0y * e1x;
                    let cp1 = e1x * e2y - e1y * e2x;
                    let cp2 = e2x * e3y - e2y * e3x;
                    let cp3 = e3x * e0y - e3y * e0x;

                    if cp0 <= 0.0 || cp1 <= 0.0 || cp2 <= 0.0 || cp3 <= 0.0 {
                        continue;
                    }

                    let sc_sum = raw_scores[i0] + raw_scores[i1] + raw_scores[i2] + raw_scores[i3];

                    let mid_x_diff = (p0.x + p2.x) - (p1.x + p3.x);
                    let mid_y_diff = (p0.y + p2.y) - (p1.y + p3.y);
                    let mid_err = (mid_x_diff * 0.5 * mid_x_diff * 0.5 + mid_y_diff * 0.5 * mid_y_diff * 0.5).sqrt() * scale_norm;

                    let d01 = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt();
                    let d23 = ((p3.x - p2.x).powi(2) + (p3.y - p2.y).powi(2)).sqrt();
                    let d12 = ((p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2)).sqrt();
                    let d30 = ((p0.x - p3.x).powi(2) + (p0.y - p3.y).powi(2)).sqrt();

                    let rel_edge_diff = ((d01 - d23).abs() / d01.max(d23).max(1.0)) + ((d12 - d30).abs() / d12.max(d30).max(1.0));

                    // Check Tab Split Penalty
                    let quad_pts = [p0, p1, p2, p3];
                    let quad_indices = [i0, i1, i2, i3];
                    let mut split_penalty = 0.0f32;

                    for e in 0..4 {
                        let s_i = quad_indices[e];
                        let e_i = quad_indices[(e + 1) % 4];
                        let ps = quad_pts[e];
                        let pe = quad_pts[(e + 1) % 4];

                        let b_dx = pe.x - ps.x;
                        let b_dy = pe.y - ps.y;
                        let b_len = (b_dx * b_dx + b_dy * b_dy).sqrt().max(1.0);

                        let mut curr_idx = (s_i + 1) % n;
                        let mut prev_sign: Option<bool> = None;
                        let mut sign_flips = 0;

                        while curr_idx != e_i {
                            let pt = contour[curr_idx];
                            let dist = ((pt.x - ps.x) * b_dy - (pt.y - ps.y) * b_dx) / b_len;
                            if dist.abs() > 4.5 {
                                let sign = dist > 0.0;
                                if let Some(psign) = prev_sign {
                                    if psign != sign {
                                        sign_flips += 1;
                                    }
                                }
                                prev_sign = Some(sign);
                            }
                            curr_idx = (curr_idx + 1) % n;
                        }

                        if sign_flips > 0 {
                            split_penalty += 50.0 * (sign_flips as f32);
                        }
                    }

                    let quad_score = sc_sum - (mid_err * 2.5) - (rel_edge_diff * 25.0) - split_penalty;

                    if quad_score > best_score {
                        best_score = quad_score;
                        best_quad = [i0, i1, i2, i3];
                    }
                }
            }
        }
    }

    Some([
        contour[best_quad[0]],
        contour[best_quad[1]],
        contour[best_quad[2]],
        contour[best_quad[3]],
    ])
}

#[test]
fn test_new_corner_detector_on_all() {
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
            let corners = evaluate_corners(&fixture.contour_points);

            if let Some(c_arr) = corners {
                let mut max_err = 0.0f32;
                for c in &c_arr {
                    let min_d = fixture.corners.iter().map(|gt_c| {
                        ((gt_c.x - c.x).powi(2) + (gt_c.y - c.y).powi(2)).sqrt()
                    }).fold(f32::INFINITY, f32::min);
                    if min_d > max_err { max_err = min_d; }
                }
                if max_err <= 7.0 {
                    passed += 1;
                } else {
                    println!("GT FAIL [{}]: max corner err = {:.1}px", fixture.id, max_err);
                }
            } else {
                println!("GT FAIL [{}]: NO CORNERS RETURNED", fixture.id);
            }
        }
        println!("\nNEW CORNER DETECTOR ON GROUND TRUTH: {} / {} PASSED ({:.1}%)\n",
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

            let corners = evaluate_corners(&fixture.piece.contour_points);
            if let Some(c_arr) = corners {
                let mut max_err = 0.0f32;
                for c in &c_arr {
                    let min_d = fixture.piece.corners.iter().map(|gt_c| {
                        ((gt_c.x - c.x).powi(2) + (gt_c.y - c.y).powi(2)).sqrt()
                    }).fold(f32::INFINITY, f32::min);
                    if min_d > max_err { max_err = min_d; }
                }
                println!("SNAP [{}]: max corner err = {:.1}px", name, max_err);
            } else {
                println!("SNAP [{}]: NO CORNERS RETURNED", name);
            }
        }
    }
}
