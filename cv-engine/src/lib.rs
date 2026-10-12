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

/// Classification of a puzzle piece cardinal edge polarity
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum EdgePolarity {
    Tab,
    Hole,
    Flat,
}

impl From<contour::EdgeType> for EdgePolarity {
    #[inline]
    fn from(t: contour::EdgeType) -> Self {
        match t {
            contour::EdgeType::Tab => EdgePolarity::Tab,
            contour::EdgeType::Hole => EdgePolarity::Hole,
            contour::EdgeType::Flat => EdgePolarity::Flat,
        }
    }
}

/// Detailed classification and geometry of one of the 4 cardinal edges
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EdgeAnalysis {
    pub index: usize,
    pub name: String,
    pub direction: String, // "N", "E", "S", "W"
    pub polarity: EdgePolarity,
    pub depth_mm: f32,
    pub chord_length_mm: f32,
    pub start_corner: Point2D,
    pub end_corner: Point2D,
    pub mid_point: Point2D,
    pub curve_points: Vec<Point2D>,
    pub normalized_profile: Vec<f32>,
}

/// Distance metric ranking for a specific tray
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrayRankingAnalysis {
    pub tray_id: u8,
    pub dist_sq: f32,
    pub is_assigned: bool,
}

/// Comprehensive, presentation-ready telemetry and classification for a scanned piece
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PieceAnalysis {
    pub center: Point2D,
    pub rotation_angle_deg: f32,
    pub bounding_width_mm: f32,
    pub bounding_height_mm: f32,
    pub perimeter_mm: f32,
    pub area_mm2: f32,
    pub aspect_ratio: f32,
    pub tab_width_mm: f32,
    pub is_border: bool,
    pub is_corner: bool,
    pub mean_rgb: [u8; 3],
    pub mean_lab: [f32; 3],
    pub texture_gradient: f32,
    pub confidence: f32,
    pub assigned_tray_id: u8,
    pub tray_rankings: Vec<TrayRankingAnalysis>,
    pub edges: Vec<EdgeAnalysis>,
    pub corners: Vec<Point2D>,
    pub contour_points: Vec<Point2D>,
}

/// Result of staged piece analysis
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub piece: Option<PieceAnalysis>,
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
    let expected_src_len = (src_w * src_h * 4) as usize;
    if src_pixels.len() < expected_src_len {
        return Err(JsValue::from_str("src_pixels buffer length is smaller than src_w * src_h * 4"));
    }

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
    pub binary: Vec<u8>,
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
    let step_x = ((w - 2 * margin_px) / 64).max(1);
    let step_y = (margin_px.saturating_sub(2) / 6).max(1);

    let mut top_pixels = Vec::with_capacity(128);
    let mut bottom_pixels = Vec::with_capacity(128);
    let mut left_pixels = Vec::with_capacity(128);
    let mut right_pixels = Vec::with_capacity(128);

    for x in (margin_px..(w - margin_px)).step_by(step_x) {
        for y in (2..margin_px).step_by(step_y) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = poster::rgb_to_luminance(r, g, b);
            top_pixels.push((r, g, b, lum));
        }
    }
    for x in (margin_px..(w - margin_px)).step_by(step_x) {
        for y in ((h - margin_px)..(h - 2)).step_by(step_y) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = poster::rgb_to_luminance(r, g, b);
            bottom_pixels.push((r, g, b, lum));
        }
    }
    for y in (margin_px..(h - margin_px)).step_by(step_x) {
        for x in (2..margin_px).step_by(step_y) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = poster::rgb_to_luminance(r, g, b);
            left_pixels.push((r, g, b, lum));
        }
    }
    for y in (margin_px..(h - margin_px)).step_by(step_x) {
        for x in ((w - margin_px)..(w - 2)).step_by(step_y) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = poster::rgb_to_luminance(r, g, b);
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

    // 2. Perceptual color distance & thresholding
    let mut buf_a = vec![0u8; total_pixels];
    let mut buf_b = vec![0u8; total_pixels];

    for i in 0..total_pixels {
        let r = dewarped_pixels[i * 4] as f32;
        let g = dewarped_pixels[i * 4 + 1] as f32;
        let b = dewarped_pixels[i * 4 + 2] as f32;
        let dr = r - bg_r;
        let dg = g - bg_g;
        let db = b - bg_b;
        let dist = (dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114).sqrt();
        buf_a[i] = dist.clamp(0.0, 255.0) as u8;
    }

    contour::gaussian_blur_3x3(&buf_a, width, height, &mut buf_b);

    let sens = sensitivity.clamp(10.0, 60.0);
    let thresh_val = (48.0 - sens * 0.55).clamp(12.0, 48.0) as u8;

    let mut foreground_count = 0;
    let border_cut = 3usize;

    buf_a.fill(0);
    for y in border_cut..(h - border_cut) {
        for x in border_cut..(w - border_cut) {
            let idx = y * w + x;
            if buf_b[idx] >= thresh_val {
                buf_a[idx] = 255;
                foreground_count += 1;
            }
        }
    }

    let binary = buf_a;

    let is_obstructed = foreground_count > (total_pixels * 55 / 100);
    if is_obstructed || foreground_count < total_pixels / 300 {
        return Err("Stage empty or obstructed by hand");
    }

    Ok(StageSegmentationOutput {
        binary,
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
    centroids_json: &str,
) -> Result<JsValue, JsValue> {
    let result = analyze_staged_piece_internal(dewarped_pixels, width, height, sensitivity, centroids_json)
        .map_err(JsValue::from_str)?;
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Internal testable implementation of staged piece analysis
pub fn analyze_staged_piece_internal(
    dewarped_pixels: &[u8],
    width: u32,
    height: u32,
    sensitivity: f32,
    centroids_json: &str,
) -> Result<AnalysisResult, &'static str> {
    let seg = segment_rectified_stage_binary(dewarped_pixels, width, height, sensitivity)?;

    let piece_profile = trace_piece_contour(&seg.binary, width, height)
        .and_then(|c| partition_edges_and_classify(&c));

    let piece_analysis = piece_profile.map(|sp| {
        build_piece_analysis(
            &sp,
            dewarped_pixels,
            &seg.binary,
            width,
            height,
            seg.foreground_count,
            centroids_json,
            0.7,
            0.2,
        )
    });

    Ok(AnalysisResult {
        piece: piece_analysis,
        binary_mask: seg.binary,
        bg_mean_rgb: seg.bg_rgb,
        fg_pixels: seg.foreground_count,
        threshold_used: seg.thresh_val,
    })
}

/// Ingestion result returned from cv-engine to web-app
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct IngestedPieceResult {
    pub success: bool,
    pub polarities: [EdgePolarity; 4], // ["TAB", "HOLE", "FLAT", "TAB"]
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

/// Thread-safe centroid cache avoiding per-frame JSON deserialization during camera streaming
static CENTROID_CACHE: std::sync::Mutex<Option<(u64, Vec<poster::Centroid>)>> = std::sync::Mutex::new(None);

pub fn parse_or_get_cached_centroids(json_str: &str) -> Option<Vec<poster::Centroid>> {
    if json_str.trim().is_empty() {
        return None;
    }
    let mut hash = 0xcbf29ce484222325u64;
    for &b in json_str.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }

    if let Ok(guard) = CENTROID_CACHE.lock()
        && let Some((cached_hash, ref cached_centroids)) = *guard
        && cached_hash == hash
    {
        return Some(cached_centroids.clone());
    }

    if let Ok(parsed) = serde_json::from_str::<Vec<poster::Centroid>>(json_str) {
        if let Ok(mut guard) = CENTROID_CACHE.lock() {
            *guard = Some((hash, parsed.clone()));
        }
        return Some(parsed);
    }

    None
}

/// Derives metric dimensions, CIELAB color, Sobel gradient texture, and poster tray distance rankings
/// from a segmented piece contour and rectified image buffer.
pub fn build_piece_analysis(
    sp: &ScannedPiece,
    dewarped_pixels: &[u8],
    binary: &[u8],
    width: u32,
    height: u32,
    fg_pixels: usize,
    centroids_json: &str,
    w_color: f32,
    w_texture: f32,
) -> PieceAnalysis {
    let px_to_mm = 25.0 / 96.0;
    let bounding_width_mm = ((sp.bounding_width * px_to_mm) * 10.0).round() / 10.0;
    let bounding_height_mm = ((sp.bounding_height * px_to_mm) * 10.0).round() / 10.0;
    let perimeter_mm = ((sp.perimeter_length * px_to_mm) * 10.0).round() / 10.0;
    let area_mm2 = (((fg_pixels as f32) * (px_to_mm * px_to_mm)) * 10.0).round() / 10.0;
    let aspect_ratio = if bounding_height_mm > 0.0 {
        ((bounding_width_mm / bounding_height_mm) * 100.0).round() / 100.0
    } else {
        1.0
    };
    let rotation_angle_deg = (((sp.rotation_angle_rad * 180.0) / std::f32::consts::PI) * 10.0).round() / 10.0;

    let edge_names = ["NORTH", "EAST", "SOUTH", "WEST"];
    let directions = ["N", "E", "S", "W"];
    let mut edges_analysis = Vec::with_capacity(4);
    let mut tab_width_sum = 0.0f32;
    let mut tab_count = 0u32;

    for (idx, edge) in sp.edges.iter().enumerate() {
        let chord_dx = edge.end_corner.x - edge.start_corner.x;
        let chord_dy = edge.end_corner.y - edge.start_corner.y;
        let chord_len_px = (chord_dx * chord_dx + chord_dy * chord_dy).sqrt();
        let chord_length_mm = ((chord_len_px * px_to_mm) * 10.0).round() / 10.0;
        let depth_mm = ((edge.curvature_depth * px_to_mm) * 10.0).round() / 10.0;
        let mid_point = Point2D {
            x: (edge.start_corner.x + edge.end_corner.x) * 0.5,
            y: (edge.start_corner.y + edge.end_corner.y) * 0.5,
        };

        if edge.edge_type == contour::EdgeType::Tab || edge.edge_type == contour::EdgeType::Hole {
            tab_width_sum += (chord_len_px * 0.32) * px_to_mm;
            tab_count += 1;
        }

        edges_analysis.push(EdgeAnalysis {
            index: idx,
            name: format!("E{} · {}", idx, edge_names[idx]),
            direction: directions[idx].to_string(),
            polarity: edge.edge_type.into(),
            depth_mm,
            chord_length_mm,
            start_corner: edge.start_corner,
            end_corner: edge.end_corner,
            mid_point,
            curve_points: edge.curve_samples.clone(),
            normalized_profile: edge.normalized_profile.clone(),
        });
    }

    let tab_width_mm = if tab_count > 0 {
        ((tab_width_sum / tab_count as f32) * 100.0).round() / 100.0
    } else {
        4.80
    };

    let w = width as usize;
    let h = height as usize;
    let mut sum_r = 0u64;
    let mut sum_g = 0u64;
    let mut sum_b = 0u64;
    let mut sum_sq_r = 0u64;
    let mut sum_sq_g = 0u64;
    let mut sum_sq_b = 0u64;
    let mut fg_count = 0u32;

    let mut chrom_sum_l = 0.0f32;
    let mut chrom_sum_a = 0.0f32;
    let mut chrom_sum_b = 0.0f32;
    let mut chrom_count = 0u32;

    let mut grad_sum = 0.0f32;
    let mut grad_sample_count = 0u32;

    let get_lum = |buf: &[u8], idx: usize| -> f32 {
        poster::rgb_to_luminance(buf[idx], buf[idx + 1], buf[idx + 2]) as f32
    };

    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let idx = y * w + x;
            if binary[idx] > 128 {
                let b_idx = idx * 4;
                let r = dewarped_pixels[b_idx] as u64;
                let g = dewarped_pixels[b_idx + 1] as u64;
                let b = dewarped_pixels[b_idx + 2] as u64;
                sum_r += r;
                sum_g += g;
                sum_b += b;
                sum_sq_r += r * r;
                sum_sq_g += g * g;
                sum_sq_b += b * b;
                fg_count += 1;

                let pix_lab = poster::rgb_to_cielab(r as u8, g as u8, b as u8);
                let chroma = (pix_lab[1] * pix_lab[1] + pix_lab[2] * pix_lab[2]).sqrt();
                if chroma >= 14.0 {
                    chrom_sum_l += pix_lab[0];
                    chrom_sum_a += pix_lab[1];
                    chrom_sum_b += pix_lab[2];
                    chrom_count += 1;
                }

                let p_l = get_lum(dewarped_pixels, (y * w + (x - 1)) * 4);
                let p_r = get_lum(dewarped_pixels, (y * w + (x + 1)) * 4);
                let p_u = get_lum(dewarped_pixels, ((y - 1) * w + x) * 4);
                let p_d = get_lum(dewarped_pixels, ((y + 1) * w + x) * 4);
                let gx = (p_r - p_l) * 0.5;
                let gy = (p_d - p_u) * 0.5;
                grad_sum += (gx * gx + gy * gy).sqrt();
                grad_sample_count += 1;
            }
        }
    }

    let (mean_r, mean_g, mean_b) = if fg_count > 0 {
        (
            (sum_r / fg_count as u64) as u8,
            (sum_g / fg_count as u64) as u8,
            (sum_b / fg_count as u64) as u8,
        )
    } else {
        (128, 128, 128)
    };

    let raw_lab = poster::rgb_to_cielab(mean_r, mean_g, mean_b);
    let mean_lab = [
        (raw_lab[0] * 10.0).round() / 10.0,
        (raw_lab[1] * 10.0).round() / 10.0,
        (raw_lab[2] * 10.0).round() / 10.0,
    ];

    let piece_color_std = if fg_count > 1 {
        let n_f = fg_count as f64;
        let var_r = (sum_sq_r as f64 / n_f) - (sum_r as f64 / n_f).powi(2);
        let var_g = (sum_sq_g as f64 / n_f) - (sum_g as f64 / n_f).powi(2);
        let var_b = (sum_sq_b as f64 / n_f) - (sum_b as f64 / n_f).powi(2);
        let mean_var = ((var_r.max(0.0) + var_g.max(0.0) + var_b.max(0.0)) / 3.0).sqrt();
        ((mean_var as f32) / 64.0).min(1.0)
    } else {
        0.10
    };

    let piece_gradient = if grad_sample_count > 0 {
        (grad_sum / (grad_sample_count as f32 * 50.0)).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let has_chromatic = fg_count > 0 && (chrom_count as f32 / fg_count as f32) >= 0.05;
    let chrom_lab = if has_chromatic {
        [
            chrom_sum_l / chrom_count as f32,
            chrom_sum_a / chrom_count as f32,
            chrom_sum_b / chrom_count as f32,
        ]
    } else {
        raw_lab
    };
    let piece_chroma = (chrom_lab[1] * chrom_lab[1] + chrom_lab[2] * chrom_lab[2]).sqrt();

    let target_lab = if has_chromatic && piece_chroma >= 15.0 {
        [
            raw_lab[0] * 0.35 + chrom_lab[0] * 0.65,
            raw_lab[1] * 0.30 + chrom_lab[1] * 0.70,
            raw_lab[2] * 0.30 + chrom_lab[2] * 0.70,
        ]
    } else {
        raw_lab
    };

    let flat_edges = sp.edges.iter().filter(|e| e.edge_type == contour::EdgeType::Flat).count();
    let is_border = flat_edges == 1 || sp.is_border;
    let is_corner = flat_edges >= 2 || sp.is_corner;
    let is_border_or_corner = is_border || is_corner;

    let mut tray_rankings: Vec<TrayRankingAnalysis> = Vec::new();
    let mut best_tray_id: u8 = if is_border_or_corner { 0 } else { 1 };
    let mut min_distance = f32::MAX;

    if is_border_or_corner {
        tray_rankings.push(TrayRankingAnalysis {
            tray_id: 0,
            dist_sq: 0.0,
            is_assigned: true,
        });
    }

    if let Some(centroids) = parse_or_get_cached_centroids(centroids_json) {
        for (i, c) in centroids.iter().enumerate() {
            let t_id = (i + 1) as u8;
            let cent_chroma = (c.lab[1] * c.lab[1] + c.lab[2] * c.lab[2]).sqrt();
            let dl = (target_lab[0] - c.lab[0]) * 0.5; // glare damping
            let da = target_lab[1] - c.lab[1];
            let db = target_lab[2] - c.lab[2];
            let norm_color_sq = (dl * dl + da * da + db * db) / 900.0;

            let d_grad = piece_gradient - c.gradient;
            let d_std = piece_color_std - c.color_std;
            let d_texture_sq = 0.55 * (d_grad * d_grad) + 0.45 * (d_std * d_std);

            let achromatic_penalty = if piece_chroma > 15.0 && cent_chroma < 8.0 {
                0.35
            } else {
                0.0
            };

            let dist_sq = ((w_color * norm_color_sq + w_texture * d_texture_sq + achromatic_penalty) * 1000.0).round() / 1000.0;

            if !is_border_or_corner && dist_sq < min_distance {
                min_distance = dist_sq;
                best_tray_id = t_id;
            }

            tray_rankings.push(TrayRankingAnalysis {
                tray_id: t_id,
                dist_sq,
                is_assigned: false,
            });
        }
    }

    if !is_border_or_corner
        && let Some(assigned_row) = tray_rankings.iter_mut().find(|r| r.tray_id == best_tray_id) {
            assigned_row.is_assigned = true;
    }

    tray_rankings.sort_by(|a, b| a.dist_sq.partial_cmp(&b.dist_sq).unwrap_or(std::cmp::Ordering::Equal));

    let confidence = if is_border_or_corner {
        0.98
    } else if min_distance == f32::MAX {
        0.50
    } else {
        ((1.0 - (min_distance * 0.4)).clamp(0.50, 0.99) * 100.0).round() / 100.0
    };

    PieceAnalysis {
        center: sp.center,
        rotation_angle_deg,
        bounding_width_mm,
        bounding_height_mm,
        perimeter_mm,
        area_mm2,
        aspect_ratio,
        tab_width_mm,
        is_border,
        is_corner,
        mean_rgb: [mean_r, mean_g, mean_b],
        mean_lab,
        texture_gradient: (piece_gradient * 100.0).round() / 100.0,
        confidence,
        assigned_tray_id: best_tray_id,
        tray_rankings,
        edges: edges_analysis,
        corners: sp.corners.to_vec(),
        contour_points: sp.contour_points.clone(),
    }
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
    let expected_src_len = (src_w * src_h * 4) as usize;
    if src_pixels.len() < expected_src_len {
        return IngestedPieceResult {
            success: false,
            polarities: [EdgePolarity::Flat; 4],
            tab_width_mm: 0.0,
            confidence: 0.0,
            tray_id: 0,
            is_border: false,
            is_corner: false,
            mean_lab: [0.0, 0.0, 0.0],
            contour_points: Vec::new(),
            corners: Vec::new(),
            normalized_profiles: Vec::new(),
            error: Some("src_pixels buffer length is smaller than src_w * src_h * 4".into()),
        };
    }

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
            polarities: [EdgePolarity::Flat; 4],
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
            polarities: [EdgePolarity::Flat; 4],
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
            polarities: [EdgePolarity::Flat; 4],
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
    let binary = seg.binary;

    // 3. Trace contour and partition edges
    let scanned_piece = match trace_piece_contour(&binary, dst_w, dst_h)
        .and_then(|c| partition_edges_and_classify(&c)) {
        Some(sp) => sp,
        None => return IngestedPieceResult {
            success: false,
            polarities: [EdgePolarity::Flat; 4],
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

    let piece_analysis = build_piece_analysis(
        &scanned_piece,
        &dewarped_buffer,
        &binary,
        dst_w,
        dst_h,
        seg.foreground_count,
        centroids_json,
        w_color,
        w_texture,
    );

    let polarities = [
        piece_analysis.edges[0].polarity,
        piece_analysis.edges[1].polarity,
        piece_analysis.edges[2].polarity,
        piece_analysis.edges[3].polarity,
    ];

    let contour_pts_flat: Vec<f32> = piece_analysis.contour_points.iter()
        .flat_map(|p| [p.x, p.y])
        .collect();

    let corners_flat: Vec<f32> = piece_analysis.corners.iter()
        .flat_map(|p| [p.x, p.y])
        .collect();

    let normalized_profiles: Vec<Vec<f32>> = piece_analysis.edges.iter()
        .map(|e| e.normalized_profile.clone())
        .collect();

    IngestedPieceResult {
        success: true,
        polarities,
        tab_width_mm: piece_analysis.tab_width_mm,
        confidence: piece_analysis.confidence,
        tray_id: piece_analysis.assigned_tray_id,
        is_border: piece_analysis.is_border,
        is_corner: piece_analysis.is_corner,
        mean_lab: piece_analysis.mean_lab,
        contour_points: contour_pts_flat,
        corners: corners_flat,
        normalized_profiles,
        error: None,
    }
}


