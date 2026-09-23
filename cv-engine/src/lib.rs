use wasm_bindgen::prelude::*;

#[derive(serde::Serialize)]
pub struct FrameStats {
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

    // Fast loop over RGBA buffer (every 4th byte stride)
    for i in 0..total_pixels {
        let offset = i * 4;
        let r = pixels[offset] as u64;
        let g = pixels[offset + 1] as u64;
        let b = pixels[offset + 2] as u64;
        // Standard perceptual luminance: 0.299 R + 0.587 G + 0.114 B
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

    let stats = FrameStats {
        width,
        height,
        avg_brightness: avg,
        elapsed_ms: end - start,
    };

    serde_wasm_bindgen::to_value(&stats).map_err(|e| JsValue::from_str(&e.to_string()))
}
