pub mod aruco;
pub mod board;
pub mod contour;
pub mod homography;
pub mod mating;

use wasm_bindgen::prelude::*;
pub use board::WasmPuzzleBoard;
use homography::{dewarp_image, Homography, Point2D};
use contour::{compute_otsu_threshold, trace_piece_contour, partition_edges_and_classify, ScannedPiece};

#[derive(serde::Serialize)]
pub struct FrameAnalysis {
    pub width: u32,
    pub height: u32,
    pub avg_brightness: f32,
    pub elapsed_ms: f64,
}

#[wasm_bindgen]
pub fn greet(name: &str) -> String {
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

/// Dewarp the specified 4-point quadrilateral from src_pixels into a rectified dst_w x dst_h RGBA buffer
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
) -> Result<Vec<u8>, JsValue> {
    let src_corners = [
        Point2D { x: p0_x, y: p0_y },
        Point2D { x: p1_x, y: p1_y },
        Point2D { x: p2_x, y: p2_y },
        Point2D { x: p3_x, y: p3_y },
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
    dewarp_image(src_pixels, src_w, src_h, dst_w, dst_h, &inv_h, &mut dst_buffer);

    Ok(dst_buffer)
}

/// Scans, segments, and analyzes the puzzle piece from a rectified RGBA buffer
#[wasm_bindgen]
pub fn analyze_staged_piece(
    dewarped_pixels: &[u8],
    width: u32,
    height: u32,
) -> Result<JsValue, JsValue> {
    let total_pixels = (width * height) as usize;
    if dewarped_pixels.len() < total_pixels * 4 {
        return Err(JsValue::from_str("Buffer size mismatch"));
    }

    // 1. Convert to Grayscale & Apply Gaussian Smoothing
    let mut raw_gray = vec![0u8; total_pixels];
    for i in 0..total_pixels {
        let r = dewarped_pixels[i * 4] as u32;
        let g = dewarped_pixels[i * 4 + 1] as u32;
        let b = dewarped_pixels[i * 4 + 2] as u32;
        raw_gray[i] = ((r * 299 + g * 587 + b * 114) / 1000) as u8;
    }

    let mut gray = vec![0u8; total_pixels];
    contour::gaussian_blur_3x3(&raw_gray, width, height, &mut gray);

    // 2. Otsu Binarization (Piece is darker than pristine white background)
    let thresh = compute_otsu_threshold(&gray);
    // Safety check: if scene is empty white arena, Otsu threshold can be too high
    let mut binary = vec![0u8; total_pixels];
    let mut foreground_count = 0;

    for i in 0..total_pixels {
        if gray[i] < thresh.min(235) {
            binary[i] = 255;
            foreground_count += 1;
        }
    }

    // If less than 2% of the arena is foreground, staging zone is empty
    if foreground_count < total_pixels / 50 {
        return Ok(JsValue::NULL);
    }

    // 3. Boundary Contour Extraction (Moore-Neighbor radial tracing)
    let contour = match trace_piece_contour(&binary, width, height) {
        Some(c) => c,
        None => return Ok(JsValue::NULL),
    };

    // 4. Partition 4 Edges & Classify Tabs, Holes, Flats
    let piece_profile: ScannedPiece = match partition_edges_and_classify(&contour) {
        Some(p) => p,
        None => return Ok(JsValue::NULL),
    };

    serde_wasm_bindgen::to_value(&piece_profile).map_err(|e| JsValue::from_str(&e.to_string()))
}
