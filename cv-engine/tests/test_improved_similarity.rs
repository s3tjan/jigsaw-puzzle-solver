use cv_engine::homography::{Point2D};
use cv_engine::poster::{
    extract_spatial_grid_precomputed,
    rotate_spatial_grid, rgba_to_grayscale, apply_clahe, compute_sobel_gradients
};
use std::fs;
use std::path::Path;

fn warp_core(
    src_rgba: &[u8], src_w: u32, src_h: u32,
    corners: &[Point2D; 4],
    dst_w: u32, dst_h: u32,
) -> Vec<u8> {
    let dst_corners = [
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: dst_w as f32, y: 0.0 },
        Point2D { x: dst_w as f32, y: dst_h as f32 },
        Point2D { x: 0.0, y: dst_h as f32 },
    ];

    let h = cv_engine::homography::Homography::from_4_points(corners, &dst_corners).unwrap();
    let inv_h = h.invert().unwrap();

    let mut dst_buf = vec![0u8; (dst_w * dst_h * 4) as usize];
    for y in 0..dst_h {
        let row_offset = (y * dst_w * 4) as usize;
        for x in 0..dst_w {
            let pt = inv_h.transform_point(Point2D { x: x as f32, y: y as f32 });
            let sx = (pt.x.round() as i32).clamp(0, src_w as i32 - 1) as u32;
            let sy = (pt.y.round() as i32).clamp(0, src_h as i32 - 1) as u32;
            let dst_idx = row_offset + (x * 4) as usize;
            let src_idx = ((sy * src_w + sx) * 4) as usize;
            dst_buf[dst_idx..dst_idx + 4].copy_from_slice(&src_rgba[src_idx..src_idx + 4]);
        }
    }
    dst_buf
}

fn compute_improved_similarity(
    piece_cells: &[cv_engine::poster::SpatialCell; 16],
    slot_cells: &[cv_engine::poster::SpatialCell; 16],
) -> f32 {
    let mut p_sum_l = 0.0f32;
    let mut p_sum_a = 0.0f32;
    let mut p_sum_b = 0.0f32;
    let mut s_sum_l = 0.0f32;
    let mut s_sum_a = 0.0f32;
    let mut s_sum_b = 0.0f32;

    for i in 0..16 {
        p_sum_l += piece_cells[i].mean_lab[0];
        p_sum_a += piece_cells[i].mean_lab[1];
        p_sum_b += piece_cells[i].mean_lab[2];
        s_sum_l += slot_cells[i].mean_lab[0];
        s_sum_a += slot_cells[i].mean_lab[1];
        s_sum_b += slot_cells[i].mean_lab[2];
    }

    let p_mean_l = p_sum_l / 16.0;
    let p_mean_a = p_sum_a / 16.0;
    let p_mean_b = p_sum_b / 16.0;
    let s_mean_l = s_sum_l / 16.0;
    let s_mean_a = s_sum_a / 16.0;
    let s_mean_b = s_sum_b / 16.0;

    // 1. Global chromaticity distance:
    // Lightness L* has 0.3 weight (handles room dimming)
    // a* and b* have full 1.0 weight (preserves color identity: blue vs gray vs red)
    let d_l = (p_mean_l - s_mean_l) * 0.3;
    let d_a = p_mean_a - s_mean_a;
    let d_b = p_mean_b - s_mean_b;
    let global_delta_e = (d_l * d_l + d_a * d_a + d_b * d_b).sqrt();
    let global_color_score = (1.0 - (global_delta_e / 40.0)).clamp(0.0, 1.0);

    let mut sum_cell_score = 0.0f32;

    for i in 0..16 {
        let pc = &piece_cells[i];
        let sc = &slot_cells[i];

        // 2. Relative spatial color pattern:
        let p_rel_l = pc.mean_lab[0] - p_mean_l;
        let p_rel_a = pc.mean_lab[1] - p_mean_a;
        let p_rel_b = pc.mean_lab[2] - p_mean_b;
        let s_rel_l = sc.mean_lab[0] - s_mean_l;
        let s_rel_a = sc.mean_lab[1] - s_mean_a;
        let s_rel_b = sc.mean_lab[2] - s_mean_b;

        let d_rel_l = (p_rel_l - s_rel_l) * 0.5;
        let d_rel_a = p_rel_a - s_rel_a;
        let d_rel_b = p_rel_b - s_rel_b;
        let rel_delta_e = (d_rel_l * d_rel_l + d_rel_a * d_rel_a + d_rel_b * d_rel_b).sqrt();
        let rel_color_score = (1.0 - (rel_delta_e / 35.0)).clamp(0.0, 1.0);

        // 3. Local gradient orientation similarity:
        // Subtract baseline 0.125 from histograms before dot product to eliminate diffuse/uniform inflation!
        // An untextured or flat cell has zero centered-histogram norm.
        let mut dot = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;
        for b in 0..8 {
            let ha = pc.grad_hist[b] - 0.125;
            let hb = sc.grad_hist[b] - 0.125;
            dot += ha * hb;
            norm_a += ha * ha;
            norm_b += hb * hb;
        }
        let grad_score = if norm_a > 1e-4 && norm_b > 1e-4 {
            let cos_sim = dot / (norm_a.sqrt() * norm_b.sqrt());
            // Map [-1, 1] to [0, 1]
            ((cos_sim + 1.0) * 0.5).clamp(0.0, 1.0)
        } else {
            // If either cell has no distinct gradient orientation, don't penalize, give neutral 0.5
            0.5
        };

        // Tri-factor fusion: 45% spatial relative color + 35% global chromaticity + 20% gradient orientation
        let cell_score = 0.45 * rel_color_score + 0.35 * global_color_score + 0.20 * grad_score;
        sum_cell_score += cell_score;
    }

    sum_cell_score / 16.0
}

#[test]
fn test_improved_similarity_discriminates_all_corners() {
    let poster_path = Path::new("datasets/poster_reference.jpg");
    if !poster_path.exists() { return; }
    let img_bytes = fs::read(poster_path).unwrap();
    let dynamic_img = image::load_from_memory(&img_bytes).unwrap();
    let rgba_img = dynamic_img.to_rgba8();
    let (poster_w, poster_h) = rgba_img.dimensions();
    let cols = 36u32;
    let rows = 28u32;
    let cell_w_f = poster_w as f32 / cols as f32;
    let cell_h_f = poster_h as f32 / rows as f32;
    let raw_rgba = rgba_img.as_raw();

    let patch_w = 48u32;
    let patch_h = 44u32;

    let corner_slots = [
        ("TL [0, 0]", 0u32, 0u32, (0, 3)),
        ("TR [0, 35]", 0u32, cols - 1, (0, 1)),
        ("BL [27, 0]", rows - 1, 0u32, (2, 3)),
        ("BR [27, 35]", rows - 1, cols - 1, (2, 1)),
    ];

    let mut poster_corner_cells = Vec::new();
    for (name, r, c, _) in &corner_slots {
        let x0 = *c as f32 * cell_w_f;
        let y0 = *r as f32 * cell_h_f;
        let slot_corners = [
            Point2D { x: x0, y: y0 },
            Point2D { x: x0 + cell_w_f, y: y0 },
            Point2D { x: x0 + cell_w_f, y: y0 + cell_h_f },
            Point2D { x: x0, y: y0 + cell_h_f },
        ];
        let core_rgba = warp_core(raw_rgba, poster_w, poster_h, &slot_corners, patch_w, patch_h);
        let gray = rgba_to_grayscale(&core_rgba, patch_w, patch_h);
        let clahe = apply_clahe(&gray, patch_w, patch_h, 4, 4, 2.0);
        let (mag, ori) = compute_sobel_gradients(&clahe, patch_w, patch_h);
        let cells = extract_spatial_grid_precomputed(
            &core_rgba, patch_w, patch_h, &mag, &ori, None, 0, 0, patch_w, patch_h
        );
        poster_corner_cells.push((*name, *r, *c, cells));
    }

    println!("\n=== TESTING IMPROVED SIMILARITY ACROSS ALL 4 CORNERS ===");
    for angle_deg in [0.0f32, 15.0f32, 30.0f32, 45.0f32] {
        println!("\n--- Drop Angle: {:.1}° ---", angle_deg);
        let angle_rad = angle_deg.to_radians();
        let cos_a = angle_rad.cos();
        let sin_a = angle_rad.sin();

        for (name_src, r_src, c_src, (req_a, req_b)) in &corner_slots {
            let x0 = *c_src as f32 * cell_w_f;
            let y0 = *r_src as f32 * cell_h_f;
            let cx = x0 + cell_w_f * 0.5;
            let cy = y0 + cell_h_f * 0.5;

            let rotate_pt = |px: f32, py: f32| -> Point2D {
                let dx = px - cx;
                let dy = py - cy;
                Point2D {
                    x: cx + dx * cos_a - dy * sin_a,
                    y: cy + dx * sin_a + dy * cos_a,
                }
            };

            let staged_corners = [
                rotate_pt(x0, y0),
                rotate_pt(x0 + cell_w_f, y0),
                rotate_pt(x0 + cell_w_f, y0 + cell_h_f),
                rotate_pt(x0, y0 + cell_h_f),
            ];

            let mut flat_edges = [false; 4];
            flat_edges[*req_a] = true;
            flat_edges[*req_b] = true;

            let piece_core_rgba = warp_core(raw_rgba, poster_w, poster_h, &staged_corners, patch_w, patch_h);
            let gray = rgba_to_grayscale(&piece_core_rgba, patch_w, patch_h);
            let clahe = apply_clahe(&gray, patch_w, patch_h, 4, 4, 2.0);
            let (mag, ori) = compute_sobel_gradients(&clahe, patch_w, patch_h);
            let piece_cells = extract_spatial_grid_precomputed(
                &piece_core_rgba, patch_w, patch_h, &mag, &ori, None, 0, 0, patch_w, patch_h
            );

            let rot_cells = [
                rotate_spatial_grid(&piece_cells, 0),
                rotate_spatial_grid(&piece_cells, 1),
                rotate_spatial_grid(&piece_cells, 2),
                rotate_spatial_grid(&piece_cells, 3),
            ];

            let mut scores = Vec::new();
            for (cand_name, cr, cc, (cand_req_a, cand_req_b)) in &corner_slots {
                let mut valid_k = None;
                for k in 0..4 {
                    let e_a_rot = (cand_req_a + 4 - k) % 4;
                    let e_b_rot = (cand_req_b + 4 - k) % 4;
                    if flat_edges[e_a_rot] && flat_edges[e_b_rot] {
                        valid_k = Some(k);
                        break;
                    }
                }

                if let Some(k) = valid_k {
                    let desc_cells = &poster_corner_cells.iter().find(|d| d.1 == *cr && d.2 == *cc).unwrap().3;
                    let sim = compute_improved_similarity(&rot_cells[k], desc_cells);
                    scores.push((*cand_name, k * 90, sim));
                }
            }

            scores.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
            println!(
                "Piece {:12} -> Best: {:12} (rot {:3}°) Conf: {:.1}% | {:?}",
                name_src,
                scores[0].0,
                scores[0].1,
                scores[0].2 * 100.0,
                scores.iter().map(|s| format!("{} {:.1}%", s.0, s.2 * 100.0)).collect::<Vec<_>>()
            );
            assert_eq!(scores[0].0, *name_src, "Piece {} failed at angle {:.1}°", name_src, angle_deg);
        }
    }

    // Now test Border Pieces
    let border_slots = [
        ("Border_Top_1 [0, 12]", 0u32, 12u32, 0usize), // Flat at Top (0)
        ("Border_Top_2 [0, 24]", 0u32, 24u32, 0usize), // Flat at Top (0)
        ("Border_Bottom_1 [27, 8]", 27u32, 8u32, 2usize), // Flat at Bottom (2)
        ("Border_Bottom_2 [27, 20]", 27u32, 20u32, 2usize), // Flat at Bottom (2)
        ("Border_Left [14, 0]", 14u32, 0u32, 3usize), // Flat at Left (3)
        ("Border_Right [18, 35]", 18u32, 35u32, 1usize), // Flat at Right (1)
    ];

    println!("\n=== TESTING BORDER PIECES ===");
    for (name_src, r_src, c_src, req_edge) in &border_slots {
        let x0 = *c_src as f32 * cell_w_f;
        let y0 = *r_src as f32 * cell_h_f;
        let slot_corners = [
            Point2D { x: x0, y: y0 },
            Point2D { x: x0 + cell_w_f, y: y0 },
            Point2D { x: x0 + cell_w_f, y: y0 + cell_h_f },
            Point2D { x: x0, y: y0 + cell_h_f },
        ];
        let core_rgba = warp_core(raw_rgba, poster_w, poster_h, &slot_corners, patch_w, patch_h);
        let gray = rgba_to_grayscale(&core_rgba, patch_w, patch_h);
        let clahe = apply_clahe(&gray, patch_w, patch_h, 4, 4, 2.0);
        let (mag, ori) = compute_sobel_gradients(&clahe, patch_w, patch_h);
        let piece_cells = extract_spatial_grid_precomputed(
            &core_rgba, patch_w, patch_h, &mag, &ori, None, 0, 0, patch_w, patch_h
        );

        // Precompute all border slots
        let mut best_slot = (0, 0);
        let mut best_sim = 0.0f32;

        for r in 0..rows {
            for c in 0..cols {
                let is_corner = (r == 0 && c == 0) || (r == 0 && c == cols - 1)
                    || (r == rows - 1 && c == 0) || (r == rows - 1 && c == cols - 1);
                let is_border = (r == 0 || r == rows - 1 || c == 0 || c == cols - 1) && !is_corner;
                if !is_border { continue; }

                // The slot's required flat edge:
                let slot_req_edge = if r == 0 { 0 }
                    else if c == cols - 1 { 1 }
                    else if r == rows - 1 { 2 }
                    else { 3 };

                // Only test rotation k that aligns the piece's flat edge with the slot's flat edge:
                // (req_edge + k) % 4 == slot_req_edge => k = (slot_req_edge + 4 - req_edge) % 4
                let k = (slot_req_edge + 4 - req_edge) % 4;
                let rot_cells = rotate_spatial_grid(&piece_cells, k);

                let sx0 = c as f32 * cell_w_f;
                let sy0 = r as f32 * cell_h_f;
                let s_corners = [
                    Point2D { x: sx0, y: sy0 },
                    Point2D { x: sx0 + cell_w_f, y: sy0 },
                    Point2D { x: sx0 + cell_w_f, y: sy0 + cell_h_f },
                    Point2D { x: sx0, y: sy0 + cell_h_f },
                ];
                let s_core = warp_core(raw_rgba, poster_w, poster_h, &s_corners, patch_w, patch_h);
                let s_gray = rgba_to_grayscale(&s_core, patch_w, patch_h);
                let s_clahe = apply_clahe(&s_gray, patch_w, patch_h, 4, 4, 2.0);
                let (s_mag, s_ori) = compute_sobel_gradients(&s_clahe, patch_w, patch_h);
                let s_cells = extract_spatial_grid_precomputed(&s_core, patch_w, patch_h, &s_mag, &s_ori, None, 0, 0, patch_w, patch_h);

                let sim = compute_improved_similarity(&rot_cells, &s_cells);
                if sim > best_sim {
                    best_sim = sim;
                    best_slot = (r, c);
                }
            }
        }

        println!(
            "Piece {:24} -> Best Match [R{:2}, C{:2}] Conf: {:.1}%",
            name_src, best_slot.0, best_slot.1, best_sim * 100.0
        );
        assert_eq!(best_slot, (*r_src, *c_src), "Border piece {} failed to match itself!", name_src);
    }
}
