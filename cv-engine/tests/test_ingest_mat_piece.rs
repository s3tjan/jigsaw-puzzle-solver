use cv_engine::{ingest_mat_piece_internal, poster::Centroid};

#[test]
fn test_ingest_mat_piece_empty_frame_rejection() {
    let w = 400u32;
    let h = 400u32;
    // White clean staging arena (empty mat)
    let pixels = vec![250u8; (w * h * 4) as usize];

    let result = ingest_mat_piece_internal(
        &pixels, w, h,
        10.0, 10.0,
        390.0, 10.0,
        390.0, 390.0,
        10.0, 390.0,
        384, 384,
        0.0,
        25.0,
        "[]",
        0.4,
        0.2,
    );

    assert!(!result.success);
    assert!(result.error.is_some());
    assert!(result.error.unwrap().contains("Stage empty"));
}

#[test]
fn test_ingest_mat_piece_synthetic_piece_detection_and_tray_routing() {
    let w = 400u32;
    let h = 400u32;
    // White background
    let mut pixels = vec![245u8; (w * h * 4) as usize];

    // Draw a dark blue square piece in the center [150..250, 150..250]
    for y in 150..250 {
        for x in 150..250 {
            let idx = ((y * w + x) * 4) as usize;
            pixels[idx] = 20;     // R
            pixels[idx + 1] = 60;  // G
            pixels[idx + 2] = 180; // B (Sky Blue)
            pixels[idx + 3] = 255;
        }
    }

    // Centroids for 2 trays: Tray 1 (Green Meadow), Tray 2 (Blue Sky)
    let centroids = vec![
        Centroid {
            lab: [45.0, -30.0, 25.0], // Meadow Green
            gradient: 0.1,
            color_std: 0.1,
            r_norm: 0.5,
            c_norm: 0.5,
        },
        Centroid {
            lab: [30.0, 5.0, -50.0],  // Blue Sky
            gradient: 0.1,
            color_std: 0.1,
            r_norm: 0.5,
            c_norm: 0.5,
        },
    ];
    let centroids_json = serde_json::to_string(&centroids).unwrap();

    let result = ingest_mat_piece_internal(
        &pixels, w, h,
        10.0, 10.0,
        390.0, 10.0,
        390.0, 390.0,
        10.0, 390.0,
        384, 384,
        0.0,
        25.0,
        &centroids_json,
        0.7,
        0.1,
    );

    assert!(result.success, "Piece should be successfully segmented: {:?}", result.error);
    assert_eq!(result.polarities.len(), 4);
    // A synthetic square has 4 straight lines, so it is classified as a corner/border piece (Tray 0)
    assert!(result.is_corner || result.is_border);
    assert_eq!(result.tray_id, 0, "Border pieces route to Tray 0 (Border)");
    assert!(result.tab_width_mm >= 0.0);
}

