pub mod fiducial;
pub mod contour;
pub mod homography;

use wasm_bindgen::prelude::*;
use homography::{dewarp_image, Homography, Point2D};
use contour::{trace_piece_contour, partition_edges_and_classify, ScannedPiece};

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

/// Scans, segments, and analyzes the puzzle piece from a rectified RGBA buffer.
/// Robust against white bond paper background: pieces have distinct contrast from the white floor.
#[wasm_bindgen]
pub fn analyze_staged_piece(
    dewarped_pixels: &[u8],
    width: u32,
    height: u32,
    sensitivity: f32,
) -> Result<JsValue, JsValue> {
    let total_pixels = (width * height) as usize;
    if dewarped_pixels.len() < total_pixels * 4 {
        return Err(JsValue::from_str("Buffer size mismatch"));
    }

    let w = width as usize;
    let h = height as usize;

    // 1. Robust Background Sampling from the 4 outer peripheral margins:
    // Samples 12px strips along Top, Bottom, Left, and Right.
    // Instead of a simple average (which gets distorted if a piece is placed near an edge),
    // we collect luminance values and use the 85th percentile (brightest ~15% rejection of shadows/piece).
    let margin_px = ((w.min(h) as f32) * 0.05).max(8.0) as usize;
    let mut perimeter_pixels: Vec<(u8, u8, u8, u8)> = Vec::with_capacity(w * 4); // (r, g, b, lum)

    // Top & Bottom strips
    for x in margin_px..(w - margin_px) {
        for y in 2..margin_px {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            perimeter_pixels.push((r, g, b, lum));
        }
        for y in (h - margin_px)..(h - 2) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            perimeter_pixels.push((r, g, b, lum));
        }
    }

    // Left & Right strips
    for y in margin_px..(h - margin_px) {
        for x in 2..margin_px {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            perimeter_pixels.push((r, g, b, lum));
        }
        for x in (w - margin_px)..(w - 2) {
            let idx = (y * w + x) * 4;
            let r = dewarped_pixels[idx];
            let g = dewarped_pixels[idx + 1];
            let b = dewarped_pixels[idx + 2];
            let lum = ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8;
            perimeter_pixels.push((r, g, b, lum));
        }
    }

    // Sort by luminance and pick the 85th percentile (clean white paper background)
    perimeter_pixels.sort_by_key(|p| p.3);
    let sample_idx = (perimeter_pixels.len() as f32 * 0.85) as usize;
    let bg_ref = if !perimeter_pixels.is_empty() {
        perimeter_pixels[sample_idx.min(perimeter_pixels.len() - 1)]
    } else {
        (240, 240, 240, 240)
    };

    let bg_r = bg_ref.0 as f32;
    let bg_g = bg_ref.1 as f32;
    let bg_b = bg_ref.2 as f32;

    // 2. Compute Color/Luminance Distance from background:
    // Works whether background is white paper (bg_lum > 180) or dark card (bg_lum < 80)
    let mut delta_img = vec![0u8; total_pixels];

    for i in 0..total_pixels {
        let r = dewarped_pixels[i * 4] as f32;
        let g = dewarped_pixels[i * 4 + 1] as f32;
        let b = dewarped_pixels[i * 4 + 2] as f32;

        let dr = r - bg_r;
        let dg = g - bg_g;
        let db = b - bg_b;

        // Euclidean perceptual color distance
        let dist = (dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114).sqrt();
        delta_img[i] = dist.clamp(0.0, 255.0) as u8;
    }

    let mut smoothed_delta = vec![0u8; total_pixels];
    contour::gaussian_blur_3x3(&delta_img, width, height, &mut smoothed_delta);

    // 3. Thresholding:
    // Sens slider: 10 to 60 (nominal 25).
    // Threshold directly scales to contrast difference:
    // sens=15 -> thresh=38; sens=25 -> thresh=27; sens=45 -> thresh=16
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

    // Morphological closing
    let mut closed_binary = vec![0u8; total_pixels];
    contour::morphological_close_3x3(&binary, width, height, &mut closed_binary);

    // Topological stage isolation test:
    // A legitimate puzzle piece is strictly an enclosed island positioned within the staging arena.
    // If a hand, fingers, or foreign object enters the stage, it crosses the boundary perimeter.
    let mut border_intrusion_count = 0usize;
    let stage_border_margin = (w.min(h) as f32 * 0.04) as usize; // ~15px
    for x in 0..w {
        for y in 0..stage_border_margin {
            if closed_binary[y * w + x] > 0 { border_intrusion_count += 1; }
            if closed_binary[(h - 1 - y) * w + x] > 0 { border_intrusion_count += 1; }
        }
    }
    for y in stage_border_margin..(h - stage_border_margin) {
        for x in 0..stage_border_margin {
            if closed_binary[y * w + x] > 0 { border_intrusion_count += 1; }
            if closed_binary[y * w + (w - 1 - x)] > 0 { border_intrusion_count += 1; }
        }
    }
    let total_border_samples = stage_border_margin * w * 2 + stage_border_margin * (h - 2 * stage_border_margin) * 2;
    let touches_stage_border = border_intrusion_count > (total_border_samples * 2 / 100);

    // Obstruction / Hand filter: >55% of stage, <0.3% of stage, or touching the stage border perimeter
    let is_obstructed = touches_stage_border || foreground_count > (total_pixels * 55 / 100);

    let piece_profile = if !is_obstructed && foreground_count >= total_pixels / 300 {
        trace_piece_contour(&closed_binary, width, height)
            .and_then(|c| partition_edges_and_classify(&c))
    } else {
        None
    };

    let bg_rgb = [bg_r as u8, bg_g as u8, bg_b as u8];
    let result = AnalysisResult {
        piece: piece_profile,
        binary_mask: closed_binary,
        bg_mean_rgb: bg_rgb,
        fg_pixels: foreground_count,
        threshold_used: thresh_val,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}
