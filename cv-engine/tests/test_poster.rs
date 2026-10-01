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
