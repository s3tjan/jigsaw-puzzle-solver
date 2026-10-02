use cv_engine::homography::{Homography, Point2D};
use cv_engine::poster::{
    compute_spatial_similarity, precompute_spatial_poster_slots, extract_spatial_grid_precomputed,
    rotate_spatial_grid, rgba_to_grayscale, apply_clahe, compute_sobel_gradients
};
use std::fs;
use std::path::Path;

fn warp_piece_to_canonical(
    src_rgba: &[u8], src_w: u32, src_h: u32,
    corners: &[Point2D; 4],
    dst_w: u32, dst_h: u32,
    margin_factor: f32,
) -> Vec<u8> {
    let exp_w = dst_w as f32 * margin_factor;
    let exp_h = dst_h as f32 * margin_factor;
    let offset_x = (exp_w - dst_w as f32) * 0.5;
    let offset_y = (exp_h - dst_h as f32) * 0.5;

    let out_w = exp_w.round() as u32;
    let out_h = exp_h.round() as u32;

    let dst_corners = [
        Point2D { x: offset_x, y: offset_y },
        Point2D { x: offset_x + dst_w as f32, y: offset_y },
        Point2D { x: offset_x + dst_w as f32, y: offset_y + dst_h as f32 },
        Point2D { x: offset_x, y: offset_y + dst_h as f32 },
    ];

    let h = Homography::from_4_points(corners, &dst_corners).unwrap();
    let inv_h = h.invert().unwrap();

    let mut dst_buf = vec![0u8; (out_w * out_h * 4) as usize];
    for y in 0..out_h {
        let row_offset = (y * out_w * 4) as usize;
        for x in 0..out_w {
            let pt = inv_h.transform_point(Point2D { x: x as f32, y: y as f32 });
            let sx = pt.x.round() as i32;
            let sy = pt.y.round() as i32;
            let dst_idx = row_offset + (x * 4) as usize;
            if sx >= 0 && sx < src_w as i32 && sy >= 0 && sy < src_h as i32 {
                let src_idx = ((sy as u32 * src_w + sx as u32) * 4) as usize;
                dst_buf[dst_idx..dst_idx + 4].copy_from_slice(&src_rgba[src_idx..src_idx + 4]);
            }
        }
    }
    dst_buf
}

#[test]
fn test_all_4_corners_unique_discrimination() {
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

    let descriptors = precompute_spatial_poster_slots(raw_rgba, poster_w, poster_h, cols, rows, 1.35);

    // 4 Corner Fixtures with their physical flat edges in local frame:
    // In local frame: edge 0=Top, 1=Right, 2=Bottom, 3=Left
    // TL: Flat at Top (0) and Left (3)
    // TR: Flat at Top (0) and Right (1)
    // BR: Flat at Bottom (2) and Right (1)
    // BL: Flat at Bottom (2) and Left (3)
    let corner_fixtures = [
        ("TL [0, 0]", 0, 0, [true, false, false, true]),
        ("TR [0, 35]", 0, cols - 1, [true, true, false, false]),
        ("BL [27, 0]", rows - 1, 0, [false, false, true, true]),
        ("BR [27, 35]", rows - 1, cols - 1, [false, true, true, false]),
    ];

    println!("\n=======================================================");
    println!(" TESTING ALL 4 CORNERS WITH GEOMETRIC EDGE CONSTRAINT");
    println!("=======================================================");

    for (name_src, r_src, c_src, flat_edges) in &corner_fixtures {
        // Cut piece from reference poster
        let x0 = *c_src as f32 * cell_w_f;
        let y0 = *r_src as f32 * cell_h_f;
        let x1 = x0 + cell_w_f;
        let y1 = y0 + cell_h_f;

        // Simulate piece dropped on stage at arbitrary angle (e.g. 25 deg)
        let angle_rad = 25.0f32.to_radians();
        let cos_a = angle_rad.cos();
        let sin_a = angle_rad.sin();
        let cx = (x0 + x1) * 0.5;
        let cy = (y0 + y1) * 0.5;

        let rotate_pt = |px: f32, py: f32| -> Point2D {
            let dx = px - cx;
            let dy = py - cy;
            Point2D {
                x: cx + dx * cos_a - dy * sin_a,
                y: cy + dx * sin_a + dy * cos_a,
            }
        };

        // 4 detected corners on stage: TL, TR, BR, BL
        let staged_corners = [
            rotate_pt(x0, y0),
            rotate_pt(x1, y0),
            rotate_pt(x1, y1),
            rotate_pt(x0, y1),
        ];

        // Rectify piece into canonical patch using its detected corners
        let rectified_rgba = warp_piece_to_canonical(
            raw_rgba, poster_w, poster_h,
            &staged_corners,
            cell_w_f.round() as u32, cell_h_f.round() as u32,
            1.35,
        );

        let patch_w = (cell_w_f * 1.35).round() as u32;
        let patch_h = (cell_h_f * 1.35).round() as u32;

        let gray = rgba_to_grayscale(&rectified_rgba, patch_w, patch_h);
        let clahe = apply_clahe(&gray, patch_w, patch_h, 4, 4, 2.0);
        let (mag, ori) = compute_sobel_gradients(&clahe, patch_w, patch_h);

        let piece_cells = extract_spatial_grid_precomputed(
            &rectified_rgba,
            patch_w,
            patch_h,
            &mag,
            &ori,
            None,
            0, 0, patch_w, patch_h,
        );

        // Precompute 4 rotations of the spatial cells: 0, 90, 180, 270 deg
        let rot_cells = [
            rotate_spatial_grid(&piece_cells, 0),
            rotate_spatial_grid(&piece_cells, 1),
            rotate_spatial_grid(&piece_cells, 2),
            rotate_spatial_grid(&piece_cells, 3),
        ];

        // For each corner slot, determine the ONLY geometrically valid rotation k
        // that aligns the piece's flat edges with the slot's outer borders:
        // TL slot: requires flat edges at Top (0) and Left (3)
        // TR slot: requires flat edges at Top (0) and Right (1)
        // BR slot: requires flat edges at Bottom (2) and Right (1)
        // BL slot: requires flat edges at Bottom (2) and Left (3)
        let slot_requirements = [
            ("TL [0, 0]", 0u32, 0u32, (0, 3)),
            ("TR [0, 35]", 0u32, cols - 1, (0, 1)),
            ("BR [27, 35]", rows - 1, cols - 1, (2, 1)),
            ("BL [27, 0]", rows - 1, 0, (2, 3)),
        ];

        let mut candidate_scores = Vec::new();

        for (cand_name, cr, cc, (req_edge_a, req_edge_b)) in &slot_requirements {
            // Find rotation k in {0, 1, 2, 3} that maps the piece's flat edges to (req_edge_a, req_edge_b)
            // When rotated by k (k * 90 deg CW):
            // Edge e in original piece moves to (e + k) % 4
            let mut valid_k = None;
            for k in 0..4 {
                let e_a_rot = (req_edge_a + 4 - k) % 4;
                let e_b_rot = (req_edge_b + 4 - k) % 4;
                if flat_edges[e_a_rot] && flat_edges[e_b_rot] {
                    valid_k = Some(k);
                    break;
                }
            }

            if let Some(k) = valid_k {
                let desc = descriptors.iter().find(|d| d.row == *cr && d.col == *cc).unwrap();
                let sim = compute_spatial_similarity(&rot_cells[k], &desc.cells);
                candidate_scores.push((*cand_name, *cr, *cc, k * 90, sim));
            }
        }

        candidate_scores.sort_by(|a, b| b.4.partial_cmp(&a.4).unwrap());

        println!(
            "Piece {:12} -> Best: {:12} (rot {:3}°) Conf: {:.1}% | Candidates: {:?}",
            name_src,
            candidate_scores[0].0,
            candidate_scores[0].3,
            candidate_scores[0].4 * 100.0,
            candidate_scores.iter().map(|c| format!("{} ({:3}°) {:.1}%", c.0, c.3, c.4 * 100.0)).collect::<Vec<_>>()
        );

        assert_eq!(candidate_scores[0].0, *name_src, "Corner piece {} did not match itself!", name_src);
    }
}
