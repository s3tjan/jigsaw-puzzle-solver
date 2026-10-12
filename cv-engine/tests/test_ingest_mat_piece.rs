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

#[test]
fn test_parse_or_get_cached_centroids() {
    use cv_engine::parse_or_get_cached_centroids;

    let c1 = vec![
        Centroid {
            lab: [50.0, 10.0, 20.0],
            gradient: 0.2,
            color_std: 0.1,
            r_norm: 0.2,
            c_norm: 0.3,
        },
    ];
    let json1 = serde_json::to_string(&c1).unwrap();

    let parsed1 = parse_or_get_cached_centroids(&json1);
    assert!(parsed1.is_some());
    assert_eq!(parsed1.as_ref().unwrap().len(), 1);

    // Call again with identical JSON string -> cache hit
    let parsed2 = parse_or_get_cached_centroids(&json1);
    assert!(parsed2.is_some());
    assert_eq!(parsed2.unwrap()[0].lab, [50.0, 10.0, 20.0]);

    // Call with different JSON -> cache update
    let c2 = vec![
        Centroid {
            lab: [80.0, -5.0, 15.0],
            gradient: 0.5,
            color_std: 0.3,
            r_norm: 0.8,
            c_norm: 0.9,
        },
    ];
    let json2 = serde_json::to_string(&c2).unwrap();
    let parsed3 = parse_or_get_cached_centroids(&json2);
    assert!(parsed3.is_some());
    assert_eq!(parsed3.unwrap()[0].lab, [80.0, -5.0, 15.0]);

    // Empty or whitespace JSON returns None
    assert!(parse_or_get_cached_centroids("").is_none());
    assert!(parse_or_get_cached_centroids("   ").is_none());
}

#[test]
fn test_analyze_staged_piece_produces_presentation_ready_telemetry() {
    use cv_engine::analyze_staged_piece_internal;

    let w = 384u32;
    let h = 384u32;
    let mut pixels = vec![250u8; (w * h * 4) as usize];

    // Draw a dark green piece in the center [140..240, 140..240]
    for y in 140..240 {
        for x in 140..240 {
            let idx = ((y * w + x) * 4) as usize;
            pixels[idx] = 20;     // R
            pixels[idx + 1] = 130; // G
            pixels[idx + 2] = 40;  // B (Meadow green)
            pixels[idx + 3] = 255;
        }
    }

    let centroids = vec![
        Centroid {
            lab: [50.0, -35.0, 30.0], // Meadow Green
            gradient: 0.1,
            color_std: 0.1,
            r_norm: 0.5,
            c_norm: 0.5,
        },
        Centroid {
            lab: [80.0, 10.0, -40.0],  // Blue Sky
            gradient: 0.1,
            color_std: 0.1,
            r_norm: 0.5,
            c_norm: 0.5,
        },
    ];
    let centroids_json = serde_json::to_string(&centroids).unwrap();

    let res = analyze_staged_piece_internal(&pixels, w, h, 25.0, &centroids_json);
    assert!(res.is_ok(), "Expected piece analysis to succeed");

    let analysis = res.unwrap();
    assert_eq!(analysis.binary_mask.len(), (w * h) as usize);
    assert!(analysis.fg_pixels > 0);
    assert!(analysis.piece.is_some(), "Piece should be detected");

    let p = analysis.piece.unwrap();
    // Verify physical metrics are populated
    assert!(p.bounding_width_mm > 0.0);
    assert!(p.bounding_height_mm > 0.0);
    assert!(p.perimeter_mm > 0.0);
    assert!(p.area_mm2 > 0.0);
    assert!(p.tab_width_mm > 0.0);
    assert_eq!(p.edges.len(), 4);

    // Verify 4 edges have names, directions, and millimeter metrics
    assert_eq!(p.edges[0].name, "E0 · NORTH");
    assert_eq!(p.edges[0].direction, "N");
    assert!(p.edges[0].chord_length_mm > 0.0);

    // Verify CIELAB and RGB color science
    assert!(p.mean_rgb[1] > p.mean_rgb[0]); // Green channel dominant
    assert!(p.mean_lab[0] > 0.0);

    // Verify tray ranking and routing
    assert!(!p.tray_rankings.is_empty());
    assert!(p.confidence >= 0.50 && p.confidence <= 1.0);
}


