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

