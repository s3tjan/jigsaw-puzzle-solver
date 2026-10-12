use cv_engine::poster::downsample_2x;
use cv_engine::fiducial::compute_focus_mtf;
use cv_engine::homography::Point2D;
use cv_engine::matcher::{evaluate_candidate_edge_pair, IndexedEdgeData};
use cv_engine::contour::{gaussian_blur_3x3, trace_piece_contour, EdgeType};

#[test]
fn test_downsample_2x_landscape_regression() {
    // Landscape image: width = 6, height = 2
    // Row 0: [ 0,  1,  2,  3,  4,  5]
    // Row 1: [ 6,  7,  8,  9, 10, 11]
    let src: Vec<u8> = (0..12).collect();
    let (downscaled, dst_w, dst_h) = downsample_2x(&src, 6, 2);

    assert_eq!(dst_w, 3);
    assert_eq!(dst_h, 1);
    assert_eq!(downscaled.len(), 3);

    // Block 0: x in 0..2, y in 0..2 -> (0 + 1 + 6 + 7 + 2) / 4 = 16 / 4 = 4
    assert_eq!(downscaled[0], 4);
    // Block 1: x in 2..4, y in 0..2 -> (2 + 3 + 8 + 9 + 2) / 4 = 24 / 4 = 6
    assert_eq!(downscaled[1], 6);
    // Block 2: x in 4..6, y in 0..2 -> (4 + 5 + 10 + 11 + 2) / 4 = 32 / 4 = 8
    assert_eq!(downscaled[2], 8);
}

#[test]
fn test_compute_focus_mtf_small_dimensions_no_panic() {
    let dummy = vec![128u8; 4 * 4 * 4];
    let corners = [
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: 3.0, y: 0.0 },
        Point2D { x: 3.0, y: 3.0 },
        Point2D { x: 0.0, y: 3.0 },
    ];
    let score = compute_focus_mtf(&dummy, 4, 4, &corners);
    assert_eq!(score, 0.0);
}

#[test]
fn test_trace_piece_contour_small_width_no_panic() {
    let w = 40u32;
    let h = 40u32;
    let mut binary = vec![0u8; (w * h) as usize];
    binary[0] = 255;
    // Should not panic from underflow
    let res = trace_piece_contour(&binary, w, h);
    // Area of 1 pixel is below valid piece area, so returns None safely
    assert!(res.is_none());
}

#[test]
fn test_mgc_ink_score_no_inflation_on_sparse_samples() {
    let mut edge_a = IndexedEdgeData::new(EdgeType::Tab, 20.0, vec![0.0; 100]);
    let mut edge_b = IndexedEdgeData::new(EdgeType::Hole, -20.0, vec![0.0; 100]);

    // Baseline score without ink samples:
    let score_no_ink = evaluate_candidate_edge_pair(&edge_a, &edge_b, 0.5).unwrap();

    // With sparse/invalid ink samples (< 2 valid samples):
    edge_a.seam_rgb_samples = vec![[100, 100, 100]];
    edge_b.seam_rgb_samples = vec![[100, 100, 100]];
    let score_with_sparse_ink = evaluate_candidate_edge_pair(&edge_a, &edge_b, 0.5).unwrap();

    // Must not artificially multiply score by 10x
    assert!(
        (score_with_sparse_ink - score_no_ink).abs() < 1e-4,
        "Score should match geometric score when ink samples are insufficient, got {} vs {}",
        score_with_sparse_ink,
        score_no_ink
    );
}

#[test]
fn test_blur_zero_dimension_no_panic() {
    let mut out = Vec::new();
    gaussian_blur_3x3(&[], 0, 0, &mut out);
}

#[test]
fn test_ingest_mat_piece_truncated_buffer_error() {
    let truncated = vec![0u8; 10];
    let res = cv_engine::ingest_mat_piece_internal(
        &truncated, 100, 100,
        0.0, 0.0, 100.0, 0.0, 100.0, 100.0, 0.0, 100.0,
        96, 96, 0.0,
        25.0, "[]", 0.7, 0.1,
    );
    assert!(!res.success);
    assert!(res.error.is_some());
    assert!(res.error.unwrap().contains("buffer length is smaller"));
}
