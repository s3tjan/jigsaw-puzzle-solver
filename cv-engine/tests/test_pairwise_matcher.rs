use cv_engine::contour::{EdgeType, PieceEdge};
use cv_engine::homography::Point2D;
use cv_engine::matcher::{
    compute_complementary_l2_distance, compute_turn_angles, evaluate_pairwise_edge_compatibility,
    fast_rejection_filter,
};

#[test]
fn test_exact_complementary_tab_and_hole_matching() {
    // Generate a synthetic male Tab profile (bell-curve shaped protrusion)
    let mut tab_profile = vec![0.0f32; 100];
    for i in 25..75 {
        let t = (i - 25) as f32 / 50.0;
        // Smooth sine-squared bell hump
        tab_profile[i] = 0.25 * (std::f32::consts::PI * t).sin().powi(2);
    }

    // In a physical die cut, the mating Hole is the exact complementary negative,
    // traversed in reverse (so sample k on tab meets sample 99-k on hole).
    // hole_profile[99 - i] = -tab_profile[i] => hole_profile[j] = -tab_profile[99 - j]
    let mut hole_profile = vec![0.0f32; 100];
    for j in 0..100 {
        hole_profile[j] = -tab_profile[99 - j];
    }

    let (l2_dist, best_shift) = compute_complementary_l2_distance(&tab_profile, &hole_profile, 2);

    println!("Exact complementary pair: L2 = {:.6}, best_shift = {}", l2_dist, best_shift);
    assert!(l2_dist < 1e-5, "Exact complementary pair must have near-zero L2 distance, got {}", l2_dist);
    assert_eq!(best_shift, 0, "Shift must be 0 for perfectly aligned profiles");

    // Test through full edge compatibility evaluator
    let edge_a = PieceEdge {
        edge_type: EdgeType::Tab,
        start_corner: Point2D { x: 0.0, y: 0.0 },
        end_corner: Point2D { x: 100.0, y: 0.0 },
        curvature_depth: 25.0,
        curve_samples: vec![],
        normalized_profile: tab_profile,
        fourier_descriptor: [0.0; 16],
    };

    let edge_b = PieceEdge {
        edge_type: EdgeType::Hole,
        start_corner: Point2D { x: 100.0, y: 0.0 },
        end_corner: Point2D { x: 0.0, y: 0.0 },
        curvature_depth: -25.0,
        curve_samples: vec![],
        normalized_profile: hole_profile,
        fourier_descriptor: [0.0; 16],
    };

    let result = evaluate_pairwise_edge_compatibility(&edge_a, &edge_b);
    assert!(result.is_compatible, "Exact complementary edges must be classified as compatible");
    assert!(result.confidence > 99.0, "Confidence must be > 99%, got {}", result.confidence);
    assert!(result.rejection_reason.is_none());
}

#[test]
fn test_fast_rejection_rules() {
    // 1. Tab vs Tab must be rejected (two protrusions collide)
    let rej_tab_tab = fast_rejection_filter(EdgeType::Tab, 20.0, EdgeType::Tab, 20.0);
    assert!(rej_tab_tab.is_some(), "Tab-Tab must be rejected");
    assert!(rej_tab_tab.unwrap().contains("collision"));

    // 2. Hole vs Hole must be rejected (two voids cannot interlock)
    let rej_hole_hole = fast_rejection_filter(EdgeType::Hole, -20.0, EdgeType::Hole, -20.0);
    assert!(rej_hole_hole.is_some(), "Hole-Hole must be rejected");
    assert!(rej_hole_hole.unwrap().contains("void"));

    // 3. Flat vs Tab must be rejected
    let rej_flat_tab = fast_rejection_filter(EdgeType::Flat, 0.0, EdgeType::Tab, 20.0);
    assert!(rej_flat_tab.is_some(), "Flat-Tab must be rejected");

    // 4. Tab vs Hole with wildly mismatched depths must be rejected
    let rej_depth_mismatch = fast_rejection_filter(EdgeType::Tab, 0.30, EdgeType::Hole, -0.08);
    assert!(rej_depth_mismatch.is_some(), "Mismatched depth must be rejected");
}

#[test]
fn test_sliding_window_recovers_corner_jitter() {
    // Tab profile
    let mut tab_profile = vec![0.0f32; 100];
    for i in 25..75 {
        let t = (i - 25) as f32 / 50.0;
        tab_profile[i] = 0.20 * (std::f32::consts::PI * t).sin();
    }

    // Hole profile shifted by +1 sample (corner detection jitter of 1 sample)
    let mut hole_profile_shifted = vec![0.0f32; 100];
    let jitter = 1i32;
    for j in 0..100 {
        let orig_idx = (99 - j) - jitter;
        if orig_idx >= 0 && orig_idx < 100 {
            hole_profile_shifted[j as usize] = -tab_profile[orig_idx as usize];
        }
    }

    let (l2_dist, best_shift) = compute_complementary_l2_distance(&tab_profile, &hole_profile_shifted, 2);
    println!("Shifted pair recovery: L2 = {:.6}, best_shift = {}", l2_dist, best_shift);

    assert_eq!(best_shift, jitter, "Sliding window must recover the exact +1 sample jitter");
    assert!(l2_dist < 0.005, "L2 distance after shift alignment must be minimal (< 0.005), got {}", l2_dist);
}

#[test]
fn test_incompatible_curve_shapes_produce_high_l2() {
    // Tab A: Single center protrusion
    let mut tab_a = vec![0.0f32; 100];
    for i in 30..70 {
        let t = (i - 30) as f32 / 40.0;
        tab_a[i] = 0.25 * (std::f32::consts::PI * t).sin();
    }

    // Hole B: Asymmetric or narrow hole that does not match Tab A
    let mut hole_b = vec![0.0f32; 100];
    for j in 10..40 {
        let t = (j - 10) as f32 / 30.0;
        hole_b[j] = -0.25 * (std::f32::consts::PI * t).sin();
    }

    let (l2_dist, _) = compute_complementary_l2_distance(&tab_a, &hole_b, 2);
    println!("Incompatible curve shapes: L2 = {:.6}", l2_dist);

    assert!(l2_dist > 0.08, "Incompatible shapes must have high L2 distance (> 0.08), got {}", l2_dist);
}

#[test]
fn test_turn_angles_intrinsic_curvature() {
    // 90 degree corner turn
    let pts = vec![
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: 10.0, y: 0.0 },
        Point2D { x: 10.0, y: 10.0 },
    ];
    let angles = compute_turn_angles(&pts);
    assert_eq!(angles.len(), 1);
    let expected = std::f32::consts::FRAC_PI_2; // +90 deg
    assert!((angles[0] - expected).abs() < 1e-4, "Turn angle must be +90 deg, got {}", angles[0]);
}
