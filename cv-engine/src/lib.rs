pub mod aruco;
pub mod board;
pub mod contour;
pub mod homography;
pub mod mating;

use wasm_bindgen::prelude::*;
pub use board::WasmPuzzleBoard;
use homography::{dewarp_image, Homography, Point2D};
use contour::{trace_piece_contour, partition_edges_and_classify, ScannedPiece};

#[derive(serde::Serialize)]
pub struct FrameAnalysis {
    pub width: u32,
    pub height: u32,
    pub avg_brightness: f32,
    pub elapsed_ms: f64,
}

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
    console_error_panic_hook::set_once();
    format!("Hello from Rust, {}! WASM is working perfectly!", name)
}

/// Process a video frame: takes an RGBA byte slice, computes metrics and returns JSON
#[wasm_bindgen]
pub fn process_frame(pixels: &[u8], width: u32, height: u32) -> Result<JsValue, JsValue> {
    let expected_len = (width * height * 4) as usize;
    if pixels.len() < expected_len {
        return Err(JsValue::from_str("Pixel buffer too small"));
    }

    let start = web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0);

    let mut sum_brightness: u64 = 0;
    let total_pixels = (width * height) as usize;

    for i in 0..total_pixels {
        let offset = i * 4;
        let r = pixels[offset] as u64;
        let g = pixels[offset + 1] as u64;
        let b = pixels[offset + 2] as u64;
        let lum = (r * 299 + g * 587 + b * 114) / 1000;
        sum_brightness += lum;
    }

    let avg = if total_pixels > 0 {
        (sum_brightness as f64 / total_pixels as f64) as f32
    } else {
        0.0
    };

    let end = web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0);

    let analysis = FrameAnalysis {
        width,
        height,
        avg_brightness: avg,
        elapsed_ms: end - start,
    };

    serde_wasm_bindgen::to_value(&analysis).map_err(|e| JsValue::from_str(&e.to_string()))
}

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
    let refined = aruco::refine_fiducial_centroid(pixels, width, height, seed_x, seed_y, radius);
    vec![refined.x, refined.y]
}

/// Automatically detects and snaps all 4 calibration mat corners
#[wasm_bindgen]
pub fn auto_detect_mat_quad(
    pixels: &[u8],
    width: u32,
    height: u32,
    p0_x: f32, p0_y: f32,
    p1_x: f32, p1_y: f32,
    p2_x: f32, p2_y: f32,
    p3_x: f32, p3_y: f32,
) -> Vec<f32> {
    let current = [
        Point2D { x: p0_x, y: p0_y },
        Point2D { x: p1_x, y: p1_y },
        Point2D { x: p2_x, y: p2_y },
        Point2D { x: p3_x, y: p3_y },
    ];
    let detected = aruco::auto_detect_mat_corners(pixels, width, height, &current);
    vec![
        detected[0].x, detected[0].y,
        detected[1].x, detected[1].y,
        detected[2].x, detected[2].y,
        detected[3].x, detected[3].y,
    ]
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
    aruco::compute_focus_mtf(pixels, width, height, &corners)
}

/// Apply radial lens distortion to a point for visual calibration overlay alignment
#[wasm_bindgen]
pub fn distort_point(x: f32, y: f32, w: f32, h: f32, k1: f32) -> Vec<f32> {
    let p = homography::apply_radial_distortion(Point2D { x, y }, w, h, k1);
    vec![p.x, p.y]
}

/// Invert radial lens distortion for a point
#[wasm_bindgen]
pub fn undistort_point(x: f32, y: f32, w: f32, h: f32, k1: f32) -> Vec<f32> {
    let p = homography::undistort_point(Point2D { x, y }, w, h, k1);
    vec![p.x, p.y]
}



/// Result of staged piece analysis including geometry, metrics, and binary mask for visual diagnostics
#[derive(serde::Serialize)]
pub struct AnalysisResult {
    pub piece: Option<ScannedPiece>,
    pub binary_mask: Vec<u8>,
    pub bg_mean_rgb: [u8; 3],
    pub stage_reflectance_rgb: [u8; 3],
    pub fg_pixels: usize,
    pub threshold_used: u8,
}

/// Dewarp the specified 4-point quadrilateral from src_pixels into a rectified dst_w x dst_h RGBA buffer
/// with optional radial lens distortion correction (k1).
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

    // The user places corners on the distorted video image.
    // In order for the planar homography H to model true perspective geometry (straight lines to straight lines),
    // we first map the placed corners to rectilinear undistorted sensor plane coordinates.
    let src_corners = [
        homography::undistort_point(Point2D { x: p0_x, y: p0_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p1_x, y: p1_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p2_x, y: p2_y }, src_w_f, src_h_f, k1),
        homography::undistort_point(Point2D { x: p3_x, y: p3_y }, src_w_f, src_h_f, k1),
    ];

    let dst_corners = [
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: dst_w as f32, y: 0.0 },
        Point2D { x: dst_w as f32, y: dst_h as f32 },
        Point2D { x: 0.0, y: dst_h as f32 },
    ];

    let h = Homography::from_4_points(&src_corners, &dst_corners)
        .ok_or_else(|| JsValue::from_str("Failed to calculate homography matrix"))?;

    let inv_h = h.invert()
        .ok_or_else(|| JsValue::from_str("Homography matrix is non-invertible"))?;

    let mut dst_buffer = vec![0u8; (dst_w * dst_h * 4) as usize];
    dewarp_image(src_pixels, src_w, src_h, dst_w, dst_h, &inv_h, k1, &mut dst_buffer);

    Ok(dst_buffer)
}

/// Scans, segments, and analyzes the puzzle piece from a rectified RGBA buffer using
/// color-opponency Chroma-Green segmentation with neutral fallback.
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

    // 1. Sample Background Mean RGB from the safe peripheral margin of the staging mat (y: 3%..10%, x: 20%..80%)
    // This samples the pure Chroma Green (#00A859) stage arena, avoiding ArUco tags and outer borders.
    let mut bg_r_sum: u64 = 0;
    let mut bg_g_sum: u64 = 0;
    let mut bg_b_sum: u64 = 0;
    let mut bg_count: u64 = 0;

    let sample_y_min = (height as f32 * 0.03) as usize;
    let sample_y_max = (height as f32 * 0.10) as usize;
    let sample_x_min = (width as f32 * 0.20) as usize;
    let sample_x_max = (width as f32 * 0.80) as usize;

    for y in sample_y_min..sample_y_max {
        for x in sample_x_min..sample_x_max {
            let idx = (y * w + x) * 4;
            bg_r_sum += dewarped_pixels[idx] as u64;
            bg_g_sum += dewarped_pixels[idx + 1] as u64;
            bg_b_sum += dewarped_pixels[idx + 2] as u64;
            bg_count += 1;
        }
    }

    let bg_r = if bg_count > 0 { (bg_r_sum / bg_count) as f32 } else { 0.0 };
    let bg_g = if bg_count > 0 { (bg_g_sum / bg_count) as f32 } else { 168.0 };
    let bg_b = if bg_count > 0 { (bg_b_sum / bg_count) as f32 } else { 89.0 };

    let is_chroma_green = bg_g > 50.0 && bg_g > bg_r * 1.25 && bg_g > bg_b * 1.25;

    // 3. Compute Delta Image:
    // If Chroma Green stage: compute true color opponency in HSV / Normalized Green ratio.
    // Jigsaw puzzle pieces (black, white, blue, yellow, red, patterned) have low saturation or completely different hue.
    let mut delta_img = vec![0u8; total_pixels];
    let sens = sensitivity.clamp(8.0, 80.0);

    for i in 0..total_pixels {
        let r = dewarped_pixels[i * 4] as f32;
        let g = dewarped_pixels[i * 4 + 1] as f32;
        let b = dewarped_pixels[i * 4 + 2] as f32;

        let dist = if is_chroma_green {
            // Compute RGB to Hue & Saturation
            let max_c = r.max(g).max(b);
            let min_c = r.min(g).min(b);
            let delta = max_c - min_c;
            
            let hue = if delta < 1e-4 {
                0.0
            } else if max_c == g {
                60.0 * (((b - r) / delta) + 2.0)
            } else if max_c == r {
                60.0 * (((g - b) / delta).rem_euclid(6.0))
            } else {
                60.0 * (((r - g) / delta) + 4.0)
            };

            let sat = if max_c > 1.0 { delta / max_c } else { 0.0 };

            // Chroma Green stage has Hue in [85, 160] deg and Saturation > 0.35.
            // If pixel is within green hue and saturated, it's stage (dist ~ 0).
            // Any piece (black, white, blue, red, yellow) has either sat < 0.25 (white/gray/black) or hue outside green.
            if hue >= 80.0 && hue <= 165.0 && sat > 0.32 {
                // Background pixel
                let dg = (g - bg_g).abs() * 0.2;
                dg.min(20.0)
            } else {
                // Piece pixel: high contrast delta
                let non_green_penalty = if hue < 75.0 || hue > 170.0 { 160.0 } else { 80.0 };
                let desat_penalty = if sat < 0.28 { 140.0 } else { 0.0 };
                let lum_delta = ((r - bg_r).abs() + (g - bg_g).abs() + (b - bg_b).abs()) * 0.4;
                (non_green_penalty + desat_penalty + lum_delta).min(255.0)
            }
        } else {
            let dr = r - bg_r;
            let dg = g - bg_g;
            let db = b - bg_b;
            (dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114).sqrt().min(255.0)
        };
        delta_img[i] = dist as u8;
    }

    let mut smoothed_delta = vec![0u8; total_pixels];
    contour::gaussian_blur_3x3(&delta_img, width, height, &mut smoothed_delta);

    // 4. Thresholding: Foreground is any pixel whose color delta exceeds sensitivity threshold
    // Strictly isolate the active piece staging square: mask out outer 13% margins (fiducial markers,
    // calibration scales, and tick marks all reside in the outer margins).
    let mut binary = vec![0u8; total_pixels];
    let mut foreground_count = 0;
    let thresh_val = if is_chroma_green { (sens * 0.85).max(12.0) as u8 } else { sens as u8 };

    let margin_frac = 0.14f32;
    let margin_y_px = (h as f32 * margin_frac) as usize;
    let margin_x_px = (w as f32 * margin_frac) as usize;

    for y in margin_y_px..(h - margin_y_px) {
        for x in margin_x_px..(w - margin_x_px) {
            let idx = y * w + x;
            if smoothed_delta[idx] >= thresh_val {
                binary[idx] = 255;
                foreground_count += 1;
            }
        }
    }

    // Apply morphological closing (3x3 dilation + erosion) to fuse small dropouts and bridge specular glare fractures
    let mut closed_binary = vec![0u8; total_pixels];
    contour::morphological_close_3x3(&binary, width, height, &mut closed_binary);

    // 5. Trace Boundary Contour
    let piece_profile = if foreground_count >= total_pixels / 250 {
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
        stage_reflectance_rgb: bg_rgb,
        fg_pixels: foreground_count,
        threshold_used: thresh_val,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}
