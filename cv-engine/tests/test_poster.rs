use cv_engine::poster::{
    build_grayscale_pyramid, compute_slot_grid, downsample_2x, ingest_poster_buffer,
    rgba_to_grayscale,
};

#[test]
fn test_rgba_to_grayscale_conversion() {
    // Red, Green, Blue, White pixels
    let rgba = vec![
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255,
    ];
    let gray = rgba_to_grayscale(&rgba, 2, 2);
    assert_eq!(gray.len(), 4);
    assert_eq!(gray[0], 76);
    assert_eq!(gray[1], 149);
    assert_eq!(gray[2], 29);
    assert_eq!(gray[3], 255);
}

#[test]
fn test_downsample_2x() {
    let src = vec![
        10, 20, 30, 40,
        10, 20, 30, 40,
        50, 60, 70, 80,
        50, 60, 70, 80,
    ];
    let (downscaled, dst_w, dst_h) = downsample_2x(&src, 4, 4);
    assert_eq!(dst_w, 2);
    assert_eq!(dst_h, 2);
    assert_eq!(downscaled.len(), 4);

    assert_eq!(downscaled[0], 15);
    assert_eq!(downscaled[1], 35);
    assert_eq!(downscaled[2], 55);
    assert_eq!(downscaled[3], 75);
}

#[test]
fn test_build_pyramid_levels() {
    let w = 128;
    let h = 64;
    let dummy = vec![128u8; (w * h) as usize];
    let pyr = build_grayscale_pyramid(&dummy, w, h, 4);

    assert_eq!(pyr.len(), 3);
    assert_eq!(pyr[0].width, 128);
    assert_eq!(pyr[0].height, 64);
    assert_eq!(pyr[0].scale, 1.0);

    assert_eq!(pyr[1].width, 64);
    assert_eq!(pyr[1].height, 32);
    assert_eq!(pyr[1].scale, 0.5);

    assert_eq!(pyr[2].width, 32);
    assert_eq!(pyr[2].height, 16);
    assert_eq!(pyr[2].scale, 0.25);
}

#[test]
fn test_compute_slot_grid_for_1008_puzzle() {
    let cols = 36;
    let rows = 28;
    let img_w = 7000;
    let img_h = 5000;
    let phys_w = 700.0;
    let phys_h = 500.0;

    let slots = compute_slot_grid(cols, rows, img_w, img_h, phys_w, phys_h);
    assert_eq!(slots.len(), 1008);

    let tl = &slots[0];
    assert_eq!(tl.col, 0);
    assert_eq!(tl.row, 0);
    assert!(tl.is_corner);
    assert!(tl.is_border);
    assert_eq!(tl.min_x_px, 0.0);
    assert_eq!(tl.min_y_px, 0.0);

    let interior = &slots[cols as usize + 1];
    assert_eq!(interior.col, 1);
    assert_eq!(interior.row, 1);
    assert!(!interior.is_border);
    assert!(!interior.is_corner);

    let corners_count = slots.iter().filter(|s| s.is_corner).count();
    assert_eq!(corners_count, 4);

    let border_count = slots.iter().filter(|s| s.is_border).count();
    assert_eq!(border_count, 2 * cols as usize + 2 * (rows as usize - 2));
}

#[test]
fn test_ingest_poster_buffer_error_handling() {
    let invalid_buf = vec![0u8; 10];
    let result = ingest_poster_buffer(&invalid_buf, 100, 100, 1008, 36, 28, 700.0, 500.0, 4);
    assert!(result.is_err());
}

#[test]
fn test_clahe_contrast_equalization() {
    use cv_engine::poster::apply_clahe;
    // 64x64 ramp image
    let mut ramp = vec![0u8; 64 * 64];
    for y in 0..64 {
        for x in 0..64 {
            ramp[y * 64 + x] = ((x + y) * 2) as u8;
        }
    }
    let equalized = apply_clahe(&ramp, 64, 64, 4, 4, 2.0);
    assert_eq!(equalized.len(), 64 * 64);
    // Equalized dynamic range should span across low and high values
    let min = *equalized.iter().min().unwrap();
    let max = *equalized.iter().max().unwrap();
    assert!(min <= 10);
    assert!(max >= 240);
}

#[test]
fn test_sobel_gradient_orientations() {
    use cv_engine::poster::compute_sobel_gradients;
    // 32x32 image with vertical edge: left half black (0), right half white (255)
    let mut step_img = vec![0u8; 32 * 32];
    for y in 0..32 {
        for x in 16..32 {
            step_img[y * 32 + x] = 255;
        }
    }
    let (mag, ori) = compute_sobel_gradients(&step_img, 32, 32);
    assert_eq!(mag.len(), 32 * 32);
    assert_eq!(ori.len(), 32 * 32);

    // Gradient magnitude at vertical boundary (x=15, 16) should be high
    let mid_edge_mag = mag[16 * 32 + 15];
    assert!(mid_edge_mag > 100, "Magnitude at edge should be strong, got {}", mid_edge_mag);

    // Orientation of horizontal step (Gx > 0, Gy = 0) is angle 0° -> bin 0
    let mid_edge_ori = ori[16 * 32 + 15];
    assert_eq!(mid_edge_ori, 0, "Orientation along vertical step should be bin 0 (approx 0 deg)");
}

#[test]
fn test_rgb_to_cielab_and_slot_preview_extraction() {
    use cv_engine::poster::{extract_slot_preview, rgb_to_cielab};
    // Pure White: L* should be ~100, a* ~ 0, b* ~ 0
    let lab_white = rgb_to_cielab(255, 255, 255);
    assert!((lab_white[0] - 100.0).abs() < 1.0, "White L* should be ~100, got {}", lab_white[0]);
    assert!(lab_white[1].abs() < 2.0);
    assert!(lab_white[2].abs() < 2.0);

    // Pure Black: L* should be ~0
    let lab_black = rgb_to_cielab(0, 0, 0);
    assert!(lab_black[0] < 1.0, "Black L* should be ~0, got {}", lab_black[0]);

    // Test slot preview extraction from 64x64 RGBA image with 4x4 grid (16 slots of 16x16)
    let mut test_rgba = vec![0u8; 64 * 64 * 4];
    // Fill slot (col 0, row 0) with solid Red (255, 0, 0, 255)
    for y in 0..16 {
        for x in 0..16 {
            let idx = (y * 64 + x) * 4;
            test_rgba[idx] = 255;
            test_rgba[idx + 1] = 0;
            test_rgba[idx + 2] = 0;
            test_rgba[idx + 3] = 255;
        }
    }

    let preview = extract_slot_preview(&test_rgba, 64, 64, 4, 4, 0, 0).expect("extract slot 0,0");
    assert_eq!(preview.col, 0);
    assert_eq!(preview.row, 0);
    assert!(preview.is_corner);
    assert_eq!(preview.mean_rgb, [255, 0, 0]);
    assert_eq!(preview.rgba_crop.len(), 16 * 16 * 4);
    // Red color should have positive a* in CIELAB
    assert!(preview.mean_lab[1] > 50.0, "Red a* should be strongly positive, got {}", preview.mean_lab[1]);
}

#[test]
fn test_locate_piece_on_poster_synthetic() {
    use cv_engine::poster::{extract_visual_fingerprint, compute_slot_similarity, rotate_gradient_histogram};

    // Construct two distinct synthetic patterns: one red with horizontal gradient, one blue
    let mut red_rgba = vec![0u8; 32 * 32 * 4];
    let mut blue_rgba = vec![0u8; 32 * 32 * 4];

    for y in 0..32 {
        for x in 0..32 {
            let idx = (y * 32 + x) * 4;
            // Red pattern with horizontal intensity ramp (produces strong Sobel X gradients)
            red_rgba[idx] = (x * 8).min(255) as u8;
            red_rgba[idx + 1] = 10;
            red_rgba[idx + 2] = 10;
            red_rgba[idx + 3] = 255;

            // Blue pattern
            blue_rgba[idx] = 10;
            blue_rgba[idx + 1] = 10;
            blue_rgba[idx + 2] = 220;
            blue_rgba[idx + 3] = 255;
        }
    }

    let (red_lab, red_hist) = extract_visual_fingerprint(&red_rgba, None, 32, 32);
    let (blue_lab, blue_hist) = extract_visual_fingerprint(&blue_rgba, None, 32, 32);

    // Self similarity should be near 1.0
    let self_sim = compute_slot_similarity(&red_lab, &red_hist, &red_lab, &red_hist);
    assert!(self_sim > 0.95, "Self similarity should be close to 1.0, got {}", self_sim);

    // Cross similarity between red and blue should be low
    let cross_sim = compute_slot_similarity(&red_lab, &red_hist, &blue_lab, &blue_hist);
    assert!(cross_sim < 0.6, "Red vs Blue similarity should be low, got {}", cross_sim);

    // Rotating 360 degrees (4 steps of 90) should return to original histogram
    let rot4 = rotate_gradient_histogram(&rotate_gradient_histogram(&rotate_gradient_histogram(&rotate_gradient_histogram(&red_hist, 1), 1), 1), 1);
    for b in 0..8 {
        assert!((red_hist[b] - rot4[b]).abs() < 1e-5);
    }
}

#[test]
fn test_poster_grid_feature_vectors() {
    use cv_engine::poster::{extract_poster_features, POSTER_TOTAL_PIECES, POSTER_BORDER_PIECES, POSTER_INTERIOR_PIECES};

    let w = 720;
    let h = 560;
    let mut poster_rgba = vec![128u8; (w * h * 4) as usize];
    // Fill top half with blue, bottom half with green
    for y in 0..h {
        for x in 0..w {
            let idx = ((y * w + x) * 4) as usize;
            if y < h / 2 {
                poster_rgba[idx] = 20;
                poster_rgba[idx + 1] = 100;
                poster_rgba[idx + 2] = 220;
            } else {
                poster_rgba[idx] = 30;
                poster_rgba[idx + 1] = 180;
                poster_rgba[idx + 2] = 40;
            }
            poster_rgba[idx + 3] = 255;
        }
    }

    let slots = extract_poster_features(&poster_rgba, w, h);
    assert_eq!(slots.len(), POSTER_TOTAL_PIECES as usize, "Must have exactly 1,008 total slots");

    let border_count = slots.iter().filter(|s| s.is_border).count();
    assert_eq!(border_count, POSTER_BORDER_PIECES as usize, "Must have exactly 124 border slots");

    let interior_count = slots.iter().filter(|s| !s.is_border).count();
    assert_eq!(interior_count, POSTER_INTERIOR_PIECES as usize, "Must have exactly 884 interior slots");

    let corner_count = slots.iter().filter(|s| s.is_corner).count();
    assert_eq!(corner_count, 4, "Must have exactly 4 corner pieces");

    // All borders must have tray_id = 0
    for s in slots.iter().filter(|s| s.is_border) {
        assert_eq!(s.tray_id, 0, "Border pieces must have tray_id 0");
    }

    // All interior pieces must have tray_id in 1..=8
    for s in slots.iter().filter(|s| !s.is_border) {
        assert!(s.tray_id >= 1 && s.tray_id <= 8, "Interior pieces must have tray_id in 1..=8");
    }
}

#[test]
fn test_seeded_kmeans_centroids() {
    use cv_engine::poster::{extract_poster_features, initialize_seeded_centroids, get_spatial_seed_tray, NUM_TRAYS};

    let w = 720;
    let h = 560;
    let poster_rgba = vec![128u8; (w * h * 4) as usize];
    let slots = extract_poster_features(&poster_rgba, w, h);
    let interior_slots: Vec<_> = slots.into_iter().filter(|s| !s.is_border).collect();

    // Verify 2x4 spatial grid distribution
    let mut seed_counts = [0u32; NUM_TRAYS + 1];
    for s in &interior_slots {
        let seed = get_spatial_seed_tray(s.r, s.c);
        assert!(seed >= 1 && seed <= 8);
        seed_counts[seed as usize] += 1;
    }

    let centroids = initialize_seeded_centroids(&interior_slots);
    assert_eq!(centroids.len(), 8, "Must generate exactly 8 seeded centroids");

    // Top row seeds (1..4) should have smaller r_norm than bottom row seeds (5..8)
    for i in 0..4 {
        assert!(centroids[i].r_norm < centroids[i + 4].r_norm, "Top band centroids should have smaller r_norm");
    }

    // Columns should be increasing across bands
    for row in 0..2 {
        for col in 0..3 {
            let left_c = centroids[row * 4 + col].c_norm;
            let right_c = centroids[row * 4 + col + 1].c_norm;
            assert!(left_c < right_c, "West to East centroids must have increasing c_norm");
        }
    }
}

#[test]
fn test_weighted_kmeans_clustering() {
    use cv_engine::poster::{extract_poster_features, cluster_interior_slots};

    let w = 720;
    let h = 560;
    let mut poster_rgba = vec![100u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let idx = ((y * w + x) * 4) as usize;
            poster_rgba[idx] = (x * 255 / w) as u8;
            poster_rgba[idx + 1] = (y * 255 / h) as u8;
            poster_rgba[idx + 2] = ((x + y) * 128 / (w + h)) as u8;
            poster_rgba[idx + 3] = 255;
        }
    }

    let slots = extract_poster_features(&poster_rgba, w, h);
    let interior_slots: Vec<_> = slots.into_iter().filter(|s| !s.is_border).collect();

    let (assignments, centroids, iterations, inertia) = cluster_interior_slots(
        &interior_slots,
        0.45,
        0.35,
        0.20,
        125,
        20,
    );

    assert_eq!(assignments.len(), 884);
    assert_eq!(centroids.len(), 8);
    assert!(iterations <= 20, "Should converge within 20 iterations, got {}", iterations);
    assert!(inertia >= 0.0);
}

#[test]
fn test_capacity_constrained_clustering() {
    use cv_engine::poster::{extract_poster_features, cluster_interior_slots, NUM_TRAYS};

    // Construct a monochromatic poster where color & texture offer no variance,
    // strongly challenging capacity bounding
    let w = 720;
    let h = 560;
    let poster_rgba = vec![120u8; (w * h * 4) as usize];
    let slots = extract_poster_features(&poster_rgba, w, h);
    let interior_slots: Vec<_> = slots.into_iter().filter(|s| !s.is_border).collect();

    let (assignments, _centroids, _iterations, _inertia) = cluster_interior_slots(
        &interior_slots,
        0.80, // heavy color weight
        0.10,
        0.10,
        125,
        20,
    );

    let mut tray_counts = [0u32; NUM_TRAYS + 1];
    for &t in &assignments {
        tray_counts[t as usize] += 1;
    }

    let mut total_interior = 0;
    for t in 1..=NUM_TRAYS {
        assert!(tray_counts[t] <= 125, "Tray {} has {} pieces exceeding max capacity 125", t, tray_counts[t]);
        total_interior += tray_counts[t];
    }
    assert_eq!(total_interior, 884, "Total assigned pieces must equal 884 interior pieces");
}

#[test]
fn test_tray_export_format() {
    use cv_engine::poster::{analyze_and_cluster_poster_internal, POSTER_TOTAL_PIECES, POSTER_BORDER_PIECES, POSTER_INTERIOR_PIECES};

    let w = 720;
    let h = 560;
    let poster_rgba = vec![150u8; (w * h * 4) as usize];

    let result = analyze_and_cluster_poster_internal(
        &poster_rgba,
        w,
        h,
        0.45,
        0.35,
        0.20,
        125,
    );

    assert_eq!(result.slots.len(), POSTER_TOTAL_PIECES as usize);
    assert_eq!(result.trays.len(), 8);
    assert_eq!(result.stats.total_pieces, POSTER_TOTAL_PIECES);
    assert_eq!(result.stats.border_pieces, POSTER_BORDER_PIECES);
    assert_eq!(result.stats.interior_pieces, POSTER_INTERIOR_PIECES);
    assert!(result.stats.is_balanced);
    assert_eq!(result.stats.overflow_count, 0);

    // Verify JSON serialization format
    let json_str = serde_json::to_string(&result).expect("Serialize to JSON");
    assert!(json_str.contains("\"slots\""));
    assert!(json_str.contains("\"trays\""));
    assert!(json_str.contains("\"stats\""));
    assert!(json_str.contains("\"is_border\""));
    assert!(json_str.contains("\"tray_id\""));
    assert!(json_str.contains("\"max_capacity\":125"));

    // Deserialize back to ensure roundtrip fidelity
    let parsed: cv_engine::poster::ClusteringResult = serde_json::from_str(&json_str).expect("Deserialize from JSON");
    assert_eq!(parsed.slots.len(), 1008);
    assert_eq!(parsed.trays.len(), 8);
}


