#![allow(clippy::too_many_arguments)]

pub mod fiducial;
pub mod contour;
pub mod homography;
pub mod poster;
pub mod matcher;

use wasm_bindgen::prelude::*;
use homography::{dewarp_image, Homography, Point2D};
use contour::{trace_piece_contour, partition_edges_and_classify, ScannedPiece};
pub use poster::{
    get_poster_grid_slots, get_slot_preview,
    init_master_poster_spatial, locate_piece_spatial, SpatialCell, SpatialSlotDescriptor,
    precompute_spatial_poster_slots, locate_piece_spatial_core,
    PosterSlotFeature, TrayInfo, ClusteringStats, ClusteringResult, Centroid,
    analyze_and_cluster_poster, analyze_and_cluster_poster_internal,
    extract_poster_features, cluster_interior_slots, initialize_seeded_centroids,
    get_spatial_seed_tray, compute_slot_cluster_distance_sq,
};
pub use matcher::{
    evaluate_pairwise_edge_compatibility, compute_complementary_l2_distance,
    fast_rejection_filter, compute_turn_angles, PairwiseMatchResult,
    identify_staged_piece_wasm,
    PieceIdentityMatch, IndexedPieceData, IndexedEdgeData,
};


/// Snaps a manual seed coordinate to the exact sub-pixel center of the nearest fiducial bullseye
#[wasm_bindgen]
pub fn snap_fiducial_corner(
    pixels: &[u8],
    width: u32,
    height: u32,
    seed_x: f32,
    seed_y: f32,
    radius: i32,
) -> Vec<f32> {
    let refined = fiducial::refine_fiducial_centroid(pixels, width, height, seed_x, seed_y, radius);
    vec![refined.x, refined.y]
}

/// Measures real-time optical focus MTF score [0, 100]% using high-frequency gradient energy
#[wasm_bindgen]
pub fn measure_stage_focus(
    pixels: &[u8],
    width: u32,
    height: u32,
    p0_x: f32, p0_y: f32,
    p1_x: f32, p1_y: f32,
    p2_x: f32, p2_y: f32,
    p3_x: f32, p3_y: f32,
) -> f32 {
    let corners = [
        Point2D { x: p0_x, y: p0_y },
        Point2D { x: p1_x, y: p1_y },
        Point2D { x: p2_x, y: p2_y },
        Point2D { x: p3_x, y: p3_y },
    ];
    fiducial::compute_focus_mtf(pixels, width, height, &corners)
}

/// Result of staged piece analysis
#[derive(serde::Serialize)]
pub struct AnalysisResult {
    pub piece: Option<ScannedPiece>,
    pub binary_mask: Vec<u8>,
    pub bg_mean_rgb: [u8; 3],
    pub fg_pixels: usize,
    pub threshold_used: u8,
}

/// Dewarp the specified 4-point quadrilateral from src_pixels into a rectified dst_w x dst_h RGBA buffer.
/// Inset crops inward by 2% (100mm fiducials to 96mm stage) so only the clean staging arena is captured.
#[wasm_bindgen]
pub fn dewarp_quad(
    src_pixels: &[u8],
    src_w: u32,
    src_h: u32,
    p0_x: f32, p0_y: f32,
    p1_x: f32, p1_y: f32,
    p2_x: f32, p2_y: f32,
    p3_x: f32, p3_y: f32,
    dst_w: u32,
    dst_h: u32,
    k1: f32,
) -> Result<Vec<u8>, JsValue> {
    let src_w_f = src_w as f32;
    let src_h_f = src_h as f32;

    let src_corners = [
        homography::undistort_point(Point2D { x: p0_x, y: p0_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p1_x, y: p1_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p2_x, y: p2_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p3_x, y: p3_y }, src_w_f, src_h_f, k1),
    ];

    let inset = dst_w as f32 * 0.02;
    let dst_corners = [
        Point2D { x: -inset, y: -inset },
        Point2D { x: dst_w as f32 + inset, y: -inset },
        Point2D { x: dst_w as f32 + inset, y: dst_h as f32 + inset },
        Point2D { x: -inset, y: dst_h as f32 + inset },
    ];

    let h = Homography::from_4_points(&src_corners, &dst_corners)
        .ok_or_else(|| JsValue::from_str("Failed to calculate homography matrix"))?;

    let inv_h = h.invert()
        .ok_or_else(|| JsValue::from_str("Homography matrix is non-invertible"))?;

    let mut dst_buffer = vec![0u8; (dst_w * dst_h * 4) as usize];
    dewarp_image(src_pixels, src_w, src_h, dst_w, dst_h, &inv_h, k1, &mut dst_buffer);

    Ok(dst_buffer)
}

/// Computes the forward mapping matrix from dewarped stage coordinates (dst_w x dst_h)
/// back to camera pixel coordinates, taking into account lens distortion k1.
#[wasm_bindgen]
pub fn map_dewarped_points_to_camera(
    points: &[f32],
    src_w: u32, src_h: u32,
    p0_x: f32, p0_y: f32,
    p1_x: f32, p1_y: f32,
    p2_x: f32, p2_y: f32,
    p3_x: f32, p3_y: f32,
    dst_w: u32, dst_h: u32,
    k1: f32,
) -> Vec<f32> {
    let src_w_f = src_w as f32;
    let src_h_f = src_h as f32;

    let src_corners = [
        homography::undistort_point(Point2D { x: p0_x, y: p0_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p1_x, y: p1_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p2_x, y: p2_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p3_x, y: p3_y }, src_w_f, src_h_f, k1),
    ];

    let inset = dst_w as f32 * 0.02;
    let dst_corners = [
        Point2D { x: -inset, y: -inset },
        Point2D { x: dst_w as f32 + inset, y: -inset },
        Point2D { x: dst_w as f32 + inset, y: dst_h as f32 + inset },
        Point2D { x: -inset, y: dst_h as f32 + inset },
    ];

    let mut result = Vec::with_capacity(points.len());
    if let Some(h) = Homography::from_4_points(&src_corners, &dst_corners)
        && let Some(inv_h) = h.invert() {
            let n = points.len() / 2;
            for i in 0..n {
                let u = points[i * 2];
                let v = points[i * 2 + 1];
                let undistorted_p = inv_h.transform_point(Point2D { x: u, y: v });
                let distorted_p = homography::apply_radial_distortion(undistorted_p, src_w_f, src_h_f, k1);
                result.push(distorted_p.x);
                result.push(distorted_p.y);
            }
            return result;
        }
    points.to_vec()
}

/// Scans, segments, and analyzes the puzzle piece from a rectified RGBA buffer.
/// Robust against white bond paper background: pieces have distinct contrast from the white floor.
#[derive(Clone, Debug)]
pub struct StageSegmentationOutput {
    pub closed_binary: Vec<u8>,
    pub bg_rgb: [u8; 3],
    pub foreground_count: usize,
    pub thresh_val: u8,
}

/// Segments a puzzle piece from a rectified RGBA buffer against white or neutral stage background.
pub fn segment_rectified_stage_binary(
    dewarped_pixels: &[u8],
    width: u32,
    height: u32,
    sensitivity: f32,
) -> Result<StageSegmentationOutput, &'static str> {
    let total_pixels = (width * height) as usize;
    if dewarped_pixels.len() < total_pixels * 4 {
        return Err("Buffer size mismatch");
    }

    let w = width as usize;
    let h = height as usize;

    // 1. Robust Background Sampling from the 4 outer peripheral margins
    let margin_px = ((w.min(h) as f32) * 0.05).max(8.0) as usize;
    
    let mut top_pixels = Vec::with_capacity(w * margin_px);
    let mut bottom_pixels = Vec::with_capacity(w * margin_px);
    let mut left_pixels = Vec::with_capacity(h * margin_px);
    let mut right_pixels = Vec::with_capacity(h * margin_px);

    for x in margin_px..(w - margin_px) {
        for y in 2..margin_px {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            top_pixels.push((r, g, b, lum));
        }
    }
    for x in margin_px..(w - margin_px) {
        for y in (h - margin_px)..(h - 2) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            bottom_pixels.push((r, g, b, lum));
        }
    }
    for y in margin_px..(h - margin_px) {
        for x in 2..margin_px {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            left_pixels.push((r, g, b, lum));
        }
    }
    for y in margin_px..(h - margin_px) {
        for x in (w - margin_px)..(w - 2) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            right_pixels.push((r, g, b, lum));
        }
    }

    let pick_percentile = |mut samples: Vec<(u8, u8, u8, u8)>| -> Option<(u8, u8, u8, u8)> {
        if samples.is_empty() { return None; }
        samples.sort_by_key(|p| p.3);
        let idx = (samples.len() as f32 * 0.85) as usize;
        Some(samples[idx.min(samples.len() - 1)])
    };

    let mut edge_refs = Vec::new();
    if let Some(p) = pick_percentile(top_pixels) { edge_refs.push(p); }
    if let Some(p) = pick_percentile(bottom_pixels) { edge_refs.push(p); }
    if let Some(p) = pick_percentile(left_pixels) { edge_refs.push(p); }
    if let Some(p) = pick_percentile(right_pixels) { edge_refs.push(p); }

    edge_refs.sort_by_key(|p| p.3);
    let bg_ref = if !edge_refs.is_empty() {
        let mid = edge_refs.len() * 3 / 4;
        edge_refs[mid.min(edge_refs.len() - 1)]
    } else {
        (240, 240, 240, 240)
    };

    let bg_r = bg_ref.0 as f32;
    let bg_g = bg_ref.1 as f32;
    let bg_b = bg_ref.2 as f32;

    // 2. Perceptual color distance
    let mut delta_img = vec![0u8; total_pixels];
    for i in 0..total_pixels {
        let r = dewarped_pixels[i * 4] as f32;
        let g = dewarped_pixels[i * 4 + 1] as f32;
        let b = dewarped_pixels[i * 4 + 2] as f32;
        let dr = r - bg_r;
        let dg = g - bg_g;
        let db = b - bg_b;
        let dist = (dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114).sqrt();
        delta_img[i] = dist.clamp(0.0, 255.0) as u8;
    }

    let mut smoothed_delta = vec![0u8; total_pixels];
    contour::gaussian_blur_3x3(&delta_img, width, height, &mut smoothed_delta);

    let sens = sensitivity.clamp(10.0, 60.0);
    let thresh_val = (48.0 - sens * 0.55).clamp(12.0, 48.0) as u8;

    let mut binary = vec![0u8; total_pixels];
    let mut foreground_count = 0;
    let border_cut = 3usize;

    for y in border_cut..(h - border_cut) {
        for x in border_cut..(w - border_cut) {
            let idx = y * w + x;
            if smoothed_delta[idx] >= thresh_val {
                binary[idx] = 255;
                foreground_count += 1;
            }
        }
    }

    let mut closed_binary = vec![0u8; total_pixels];
    contour::morphological_close_3x3(&binary, width, height, &mut closed_binary);

    // Topological stage isolation test:
    let stage_border_margin = ((w.min(h) as f32 * 0.015) as usize).clamp(3, 6);
    let mut border_intrusion_count = 0usize;
    for x in border_cut..(w - border_cut) {
        for y in border_cut..stage_border_margin {
            if closed_binary[y * w + x] > 0 { border_intrusion_count += 1; }
            if closed_binary[(h - 1 - y) * w + x] > 0 { border_intrusion_count += 1; }
        }
    }
    for y in stage_border_margin..(h - stage_border_margin) {
        for x in border_cut..stage_border_margin {
            if closed_binary[y * w + x] > 0 { border_intrusion_count += 1; }
            if closed_binary[y * w + (w - 1 - x)] > 0 { border_intrusion_count += 1; }
        }
    }
    let total_border_samples = (stage_border_margin - border_cut).max(1) * (w - 2 * border_cut) * 2
        + (stage_border_margin - border_cut).max(1) * (h - 2 * stage_border_margin) * 2;
    let touches_stage_border = border_intrusion_count > (total_border_samples * 10 / 100);

    let is_obstructed = touches_stage_border || foreground_count > (total_pixels * 55 / 100);
    if is_obstructed || foreground_count < total_pixels / 300 {
        return Err("Stage empty or obstructed by hand");
    }

    Ok(StageSegmentationOutput {
        closed_binary,
        bg_rgb: [bg_r as u8, bg_g as u8, bg_b as u8],
        foreground_count,
        thresh_val,
    })
}

/// Scans, segments, and analyzes the puzzle piece from a rectified RGBA buffer.
#[wasm_bindgen]
pub fn analyze_staged_piece(
    dewarped_pixels: &[u8],
    width: u32,
    height: u32,
    sensitivity: f32,
) -> Result<JsValue, JsValue> {
    let seg = match segment_rectified_stage_binary(dewarped_pixels, width, height, sensitivity) {
        Ok(s) => s,
        Err(e) => return Err(JsValue::from_str(e)),
    };

    let piece_profile = trace_piece_contour(&seg.closed_binary, width, height)
        .and_then(|c| partition_edges_and_classify(&c));

    let result = AnalysisResult {
        piece: piece_profile,
        binary_mask: seg.closed_binary,
        bg_mean_rgb: seg.bg_rgb,
        fg_pixels: seg.foreground_count,
        threshold_used: seg.thresh_val,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Ingestion result returned from cv-engine to web-app
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct IngestedPieceResult {
    pub success: bool,
    pub polarities: [String; 4], // ["TAB", "HOLE", "FLAT", "TAB"]
    pub tab_width_mm: f32,
    pub confidence: f32,
    pub tray_id: u8,             // 0 for border, 1..8 for interior trays
    pub is_border: bool,
    pub is_corner: bool,
    pub mean_lab: [f32; 3],
    pub contour_points: Vec<f32>,
    pub corners: Vec<f32>,
    pub normalized_profiles: Vec<Vec<f32>>, // 4 x 100 normalized baseline chord profile points
    pub error: Option<String>,
}

/// Continuous Mat Ingestion Bridge (Task ING-02B)
/// Unwarps camera frame using fiducial corners, detects and classifies 4 piece edges,
/// computes core CIELAB and Sobel texture, and routes piece to the closest poster tray centroid.
#[wasm_bindgen]
pub fn ingest_mat_piece(
    src_pixels: &[u8],
    src_w: u32,
    src_h: u32,
    p0_x: f32, p0_y: f32,
    p1_x: f32, p1_y: f32,
    p2_x: f32, p2_y: f32,
    p3_x: f32, p3_y: f32,
    dst_w: u32,
    dst_h: u32,
    k1: f32,
    sensitivity: f32,
    centroids_json: &str,
    w_color: f32,
    w_texture: f32,
) -> Result<JsValue, JsValue> {
    let result = ingest_mat_piece_internal(
        src_pixels, src_w, src_h,
        p0_x, p0_y, p1_x, p1_y, p2_x, p2_y, p3_x, p3_y,
        dst_w, dst_h, k1, sensitivity, centroids_json, w_color, w_texture,
    );
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Internal testable implementation of mat piece ingestion
pub fn ingest_mat_piece_internal(
    src_pixels: &[u8],
    src_w: u32,
    src_h: u32,
    p0_x: f32, p0_y: f32,
    p1_x: f32, p1_y: f32,
    p2_x: f32, p2_y: f32,
    p3_x: f32, p3_y: f32,
    dst_w: u32,
    dst_h: u32,
    k1: f32,
    sensitivity: f32,
    centroids_json: &str,
    w_color: f32,
    w_texture: f32,
) -> IngestedPieceResult {
    // 1. Unwarp quadrilateral from camera frame to staging arena (96px = 25mm metric grounding)
    let src_w_f = src_w as f32;
    let src_h_f = src_h as f32;

    let src_corners = [
        homography::undistort_point(Point2D { x: p0_x, y: p0_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p1_x, y: p1_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p2_x, y: p2_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p3_x, y: p3_y }, src_w_f, src_h_f, k1),
    ];

    let inset = dst_w as f32 * 0.02;
    let dst_corners = [
        Point2D { x: -inset, y: -inset },
        Point2D { x: dst_w as f32 + inset, y: -inset },
        Point2D { x: dst_w as f32 + inset, y: dst_h as f32 + inset },
        Point2D { x: -inset, y: dst_h as f32 + inset },
    ];

    let h = match Homography::from_4_points(&src_corners, &dst_corners) {
        Some(mat) => mat,
        None => return IngestedPieceResult {
            success: false,
            polarities: ["FLAT".into(), "FLAT".into(), "FLAT".into(), "FLAT".into()],
            tab_width_mm: 0.0,
            confidence: 0.0,
            tray_id: 0,
            is_border: false,
            is_corner: false,
            mean_lab: [0.0, 0.0, 0.0],
            contour_points: Vec::new(),
            corners: Vec::new(),
            normalized_profiles: Vec::new(),
            error: Some("Failed to compute staging homography matrix".into()),
        },
    };

    let inv_h = match h.invert() {
        Some(mat) => mat,
        None => return IngestedPieceResult {
            success: false,
            polarities: ["FLAT".into(), "FLAT".into(), "FLAT".into(), "FLAT".into()],
            tab_width_mm: 0.0,
            confidence: 0.0,
            tray_id: 0,
            is_border: false,
            is_corner: false,
            mean_lab: [0.0, 0.0, 0.0],
            contour_points: Vec::new(),
            corners: Vec::new(),
            normalized_profiles: Vec::new(),
            error: Some("Homography matrix is non-invertible".into()),
        },
    };

    let mut dewarped_buffer = vec![0u8; (dst_w * dst_h * 4) as usize];
    dewarp_image(src_pixels, src_w, src_h, dst_w, dst_h, &inv_h, k1, &mut dewarped_buffer);

    // 2. Segment piece from stage background
    let seg = match segment_rectified_stage_binary(&dewarped_buffer, dst_w, dst_h, sensitivity) {
        Ok(s) => s,
        Err(err_msg) => return IngestedPieceResult {
            success: false,
            polarities: ["FLAT".into(), "FLAT".into(), "FLAT".into(), "FLAT".into()],
            tab_width_mm: 0.0,
            confidence: 0.0,
            tray_id: 0,
            is_border: false,
            is_corner: false,
            mean_lab: [0.0, 0.0, 0.0],
            contour_points: Vec::new(),
            corners: Vec::new(),
            normalized_profiles: Vec::new(),
            error: Some(err_msg.into()),
        },
    };
    let closed_binary = seg.closed_binary;

    // 3. Trace contour and partition edges
    let scanned_piece = match trace_piece_contour(&closed_binary, dst_w, dst_h)
        .and_then(|c| partition_edges_and_classify(&c)) {
        Some(sp) => sp,
        None => return IngestedPieceResult {
            success: false,
            polarities: ["FLAT".into(), "FLAT".into(), "FLAT".into(), "FLAT".into()],
            tab_width_mm: 0.0,
            confidence: 0.0,
            tray_id: 0,
            is_border: false,
            is_corner: false,
            mean_lab: [0.0, 0.0, 0.0],
            contour_points: Vec::new(),
            corners: Vec::new(),
            normalized_profiles: Vec::new(),
            error: Some("Failed to classify piece contour and corners".into()),
        },
    };

    let polarities = [
        match scanned_piece.edges[0].edge_type {
            contour::EdgeType::Tab => "TAB".to_string(),
            contour::EdgeType::Hole => "HOLE".to_string(),
            contour::EdgeType::Flat => "FLAT".to_string(),
        },
        match scanned_piece.edges[1].edge_type {
            contour::EdgeType::Tab => "TAB".to_string(),
            contour::EdgeType::Hole => "HOLE".to_string(),
            contour::EdgeType::Flat => "FLAT".to_string(),
        },
        match scanned_piece.edges[2].edge_type {
            contour::EdgeType::Tab => "TAB".to_string(),
            contour::EdgeType::Hole => "HOLE".to_string(),
            contour::EdgeType::Flat => "FLAT".to_string(),
        },
        match scanned_piece.edges[3].edge_type {
            contour::EdgeType::Tab => "TAB".to_string(),
            contour::EdgeType::Hole => "HOLE".to_string(),
            contour::EdgeType::Flat => "FLAT".to_string(),
        },
    ];

    // Compute average tab width in mm (96px = 25mm metric anchor)
    let px_to_mm = 25.0 / 96.0;
    let mut tab_width_sum = 0.0f32;
    let mut tab_count = 0u32;
    for edge in &scanned_piece.edges {
        if edge.edge_type == contour::EdgeType::Tab || edge.edge_type == contour::EdgeType::Hole {
            let chord_dx = edge.end_corner.x - edge.start_corner.x;
            let chord_dy = edge.end_corner.y - edge.start_corner.y;
            let chord_len_px = (chord_dx * chord_dx + chord_dy * chord_dy).sqrt();
            // Nominal puzzle tab width is approximately 0.28x to 0.35x chord length
            let tab_width_mm = (chord_len_px * 0.32) * px_to_mm;
            tab_width_sum += tab_width_mm;
            tab_count += 1;
        }
    }
    let measured_tab_width_mm = if tab_count > 0 {
        tab_width_sum / tab_count as f32
    } else {
        4.80 // standard jigsaw tab width fallback
    };

    // 4. Sample piece core CIELAB and Sobel gradient texture
    let w = dst_w as usize;
    let min_x = (scanned_piece.center.x - 12.0).clamp(0.0, dst_w as f32 - 1.0) as usize;
    let max_x = (scanned_piece.center.x + 12.0).clamp(0.0, dst_w as f32 - 1.0) as usize;
    let min_y = (scanned_piece.center.y - 12.0).clamp(0.0, dst_h as f32 - 1.0) as usize;
    let max_y = (scanned_piece.center.y + 12.0).clamp(0.0, dst_h as f32 - 1.0) as usize;

    let mut sum_r = 0u64;
    let mut sum_g = 0u64;
    let mut sum_b = 0u64;
    let mut core_pix_count = 0u32;

    for y in min_y..=max_y {
        for x in min_x..=max_x {
            let idx = y * w + x;
            if closed_binary[idx] > 128 {
                let b_idx = idx * 4;
                sum_r += dewarped_buffer[b_idx] as u64;
                sum_g += dewarped_buffer[b_idx + 1] as u64;
                sum_b += dewarped_buffer[b_idx + 2] as u64;
                core_pix_count += 1;
            }
        }
    }

    let (mean_r, mean_g, mean_b) = if core_pix_count > 0 {
        (
            (sum_r / core_pix_count as u64) as u8,
            (sum_g / core_pix_count as u64) as u8,
            (sum_b / core_pix_count as u64) as u8,
        )
    } else {
        (128, 128, 128)
    };

    let mean_lab = poster::rgb_to_cielab(mean_r, mean_g, mean_b);

    // Compute core Sobel texture
    let mut core_grad_sum = 0.0f32;
    let mut core_grad_count = 0u32;
    for y in (min_y + 1)..max_y {
        for x in (min_x + 1)..max_x {
            let idx = y * w + x;
            if closed_binary[idx] > 128 {
                let p_l = dewarped_buffer[(y * w + (x - 1)) * 4] as f32;
                let p_r = dewarped_buffer[(y * w + (x + 1)) * 4] as f32;
                let p_u = dewarped_buffer[((y - 1) * w + x) * 4] as f32;
                let p_d = dewarped_buffer[((y + 1) * w + x) * 4] as f32;
                let gx = (p_r - p_l) * 0.5;
                let gy = (p_d - p_u) * 0.5;
                core_grad_sum += (gx * gx + gy * gy).sqrt();
                core_grad_count += 1;
            }
        }
    }
    let piece_gradient = if core_grad_count > 0 {
        (core_grad_sum / (core_grad_count as f32 * 50.0)).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // 5. Match against active poster tray centroids
    let mut assigned_tray: u8 = if scanned_piece.is_border || scanned_piece.is_corner { 0 } else { 1 };
    let mut best_dist_sq = f32::MAX;

    if !scanned_piece.is_border && !scanned_piece.is_corner
        && let Ok(centroids) = serde_json::from_str::<Vec<poster::Centroid>>(centroids_json)
            && !centroids.is_empty() {
                for (idx, centroid) in centroids.iter().enumerate() {
                    let dl = (mean_lab[0] - centroid.lab[0]) * 0.5; // glare damping
                    let da = mean_lab[1] - centroid.lab[1];
                    let db = mean_lab[2] - centroid.lab[2];
                    let norm_color_sq = (dl * dl + da * da + db * db) / 900.0;

                    let d_grad = piece_gradient - centroid.gradient;
                    let d_texture_sq = d_grad * d_grad;

                    let dist_sq = w_color * norm_color_sq + w_texture * d_texture_sq;
                    if dist_sq < best_dist_sq {
                        best_dist_sq = dist_sq;
                        assigned_tray = (idx + 1) as u8;
                    }
                }
            }

    let flat_edges = scanned_piece.edges.iter().filter(|e| e.edge_type == contour::EdgeType::Flat).count();
    let is_border = flat_edges == 1;
    let is_corner = flat_edges >= 2;

    let contour_pts_flat: Vec<f32> = scanned_piece.contour_points.iter()
        .flat_map(|p| [p.x, p.y])
        .collect();

    let corners_flat: Vec<f32> = scanned_piece.corners.iter()
        .flat_map(|p| [p.x, p.y])
        .collect();

    let normalized_profiles: Vec<Vec<f32>> = scanned_piece.edges.iter()
        .map(|e| e.normalized_profile.clone())
        .collect();

    IngestedPieceResult {
        success: true,
        polarities,
        tab_width_mm: (measured_tab_width_mm * 100.0).round() / 100.0,
        confidence: 0.95,
        tray_id: assigned_tray,
        is_border,
        is_corner,
        mean_lab,
        contour_points: contour_pts_flat,
        corners: corners_flat,
        normalized_profiles,
        error: None,
    }
}

