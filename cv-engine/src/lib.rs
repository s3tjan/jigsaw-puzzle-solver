pub mod aruco;
pub mod homography;

use wasm_bindgen::prelude::*;
use homography::{dewarp_image, Homography, Point2D};

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
