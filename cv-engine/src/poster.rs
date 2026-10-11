use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use std::sync::Mutex;
use crate::homography::{Homography, Point2D};

/// Representation of a single pyramid level with intensity and gradient orientations.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PyramidLevel {
    pub level: usize,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    /// Grayscale intensity values [0, 255]
    pub pixels: Vec<u8>,
    /// Sobel gradient magnitude [0, 255] (contrast normalized)
    pub grad_magnitude: Vec<u8>,
    /// Sobel gradient orientation quantized into 8 directional bins [0..7]
    pub grad_orientation: Vec<u8>,
}

/// Metadata and precomputed visual structures for the master puzzle reference poster.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PosterMetadata {
    pub total_pieces: u32,
    pub grid_cols: u32,
    pub grid_rows: u32,
    pub physical_width_mm: f32,
    pub physical_height_mm: f32,
    pub original_width_px: u32,
    pub original_height_px: u32,
    pub cell_width_px: f32,
    pub cell_height_px: f32,
    pub cell_width_mm: f32,
    pub cell_height_mm: f32,
}

/// Nominal slot boundary in the reference poster coordinate space.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct PosterSlot {
    pub col: u32,
    pub row: u32,
    pub min_x_px: f32,
    pub min_y_px: f32,
    pub max_x_px: f32,
    pub max_y_px: f32,
    pub center_x_px: f32,
    pub center_y_px: f32,
    pub center_x_mm: f32,
    pub center_y_mm: f32,
    pub is_border: bool,
    pub is_corner: bool,
}

/// Extracted slot crop and visual cue metadata for Mode C (Targeted Hole-Filling).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SlotPreview {
    pub col: u32,
    pub row: u32,
    pub width: u32,
    pub height: u32,
    pub is_border: bool,
    pub is_corner: bool,
    /// Rectified RGBA pixel crop of this slot from the poster
    pub rgba_crop: Vec<u8>,
    /// Average RGB color of the slot [R, G, B]
    pub mean_rgb: [u8; 3],
    /// CIELAB color representation [L*, a*, b*] for illumination-invariant color matching
    pub mean_lab: [f32; 3],
}

/// Master Poster Engine holding the ingested master artwork and precomputed pyramids.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MasterPoster {
    pub metadata: PosterMetadata,
    pub pyramids: Vec<PyramidLevel>,
}

/// Standard ITU-R BT.601 perceptual luminance calculation from RGB
#[inline(always)]
pub fn rgb_to_luminance(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 299 + g as u32 * 587 + b as u32 * 114) / 1000) as u8
}

/// Classify whether a grid slot (r, c) is on the boundary (border) or vertex (corner)
#[inline(always)]
pub fn classify_grid_cell(r: u32, c: u32, rows: u32, cols: u32) -> (bool, bool) {
    let is_top = r == 0;
    let is_bottom = r == rows.saturating_sub(1);
    let is_left = c == 0;
    let is_right = c == cols.saturating_sub(1);
    let is_border = is_top || is_bottom || is_left || is_right;
    let is_corner = (is_left || is_right) && (is_top || is_bottom);
    (is_border, is_corner)
}

static SRGB_TO_LINEAR_LUT: std::sync::LazyLock<[f32; 256]> = std::sync::LazyLock::new(|| {
    let mut lut = [0.0f32; 256];
    for (i, item) in lut.iter_mut().enumerate() {
        let v = i as f32 / 255.0;
        *item = if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        };
    }
    lut
});

/// Convert an RGBA buffer (4 bytes per pixel) into a single-channel grayscale buffer (1 byte per pixel).
/// Uses standard luminance weights: Y = 0.299*R + 0.587*G + 0.114*B.
pub fn rgba_to_grayscale(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let pixel_count = (width * height) as usize;
    let mut gray = vec![0u8; pixel_count];
    let src_len = rgba.len().min(pixel_count * 4);

    for i in 0..(src_len / 4) {
        gray[i] = rgb_to_luminance(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    }
    gray
}

/// Contrast-Limited Adaptive Histogram Equalization (CLAHE) on a grayscale image.
/// Divides image into grid of contextual regions (tiles), computes clipped local histograms,
/// and applies bilinear interpolation between tile mappings.
/// Eliminates specular reflections and shadows from glossy box covers.
pub fn apply_clahe(src: &[u8], width: u32, height: u32, tiles_x: u32, tiles_y: u32, clip_limit_factor: f32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    if w == 0 || h == 0 {
        return Vec::new();
    }
    let tx = (tiles_x as usize).max(1).min(w);
    let ty = (tiles_y as usize).max(1).min(h);

    let tile_w = w.div_ceil(tx);
    let tile_h = h.div_ceil(ty);

    // Build transformation LUT for each tile
    let mut tile_mappings = vec![vec![0u8; 256]; tx * ty];

    for gy in 0..ty {
        let y0 = gy * tile_h;
        let y1 = (y0 + tile_h).min(h);
        for gx in 0..tx {
            let x0 = gx * tile_w;
            let x1 = (x0 + tile_w).min(w);

            let mut hist = [0u32; 256];
            let mut count = 0u32;
            for y in y0..y1 {
                let row_idx = y * w;
                for x in x0..x1 {
                    let val = src[row_idx + x] as usize;
                    hist[val] += 1;
                    count += 1;
                }
            }

            if count == 0 {
                continue;
            }

            // Clip histogram
            let clip_limit = ((count as f32 / 256.0) * clip_limit_factor).max(1.0) as u32;
            let mut clipped_excess = 0u32;
            for val in &mut hist {
                if *val > clip_limit {
                    clipped_excess += *val - clip_limit;
                    *val = clip_limit;
                }
            }

            // Redistribute excess evenly across all bins
            let redistrib = clipped_excess / 256;
            let residual = clipped_excess % 256;
            for (i, val) in hist.iter_mut().enumerate() {
                *val += redistrib;
                if (i as u32) < residual {
                    *val += 1;
                }
            }

            // Calculate Cumulative Distribution Function (CDF)
            let mut cdf = 0u32;
            let tile_idx = gy * tx + gx;
            for i in 0..256 {
                cdf += hist[i];
                let mapped = ((cdf as f32 / count as f32) * 255.0).round();
                tile_mappings[tile_idx][i] = mapped.clamp(0.0, 255.0) as u8;
            }
        }
    }

    // Bilinear interpolation of mapping across tile centers
    let mut dst = vec![0u8; w * h];
    for y in 0..h {
        let f_gy = (y as f32 / tile_h as f32) - 0.5;
        let gy0 = (f_gy.floor() as isize).max(0).min(ty as isize - 1) as usize;
        let gy1 = (gy0 + 1).min(ty - 1);
        let wy = (f_gy - f_gy.floor()).clamp(0.0, 1.0);

        let row_idx = y * w;
        for x in 0..w {
            let f_gx = (x as f32 / tile_w as f32) - 0.5;
            let gx0 = (f_gx.floor() as isize).max(0).min(tx as isize - 1) as usize;
            let gx1 = (gx0 + 1).min(tx - 1);
            let wx = (f_gx - f_gx.floor()).clamp(0.0, 1.0);

            let val = src[row_idx + x] as usize;
            let v00 = tile_mappings[gy0 * tx + gx0][val] as f32;
            let v10 = tile_mappings[gy0 * tx + gx1][val] as f32;
            let v01 = tile_mappings[gy1 * tx + gx0][val] as f32;
            let v11 = tile_mappings[gy1 * tx + gx1][val] as f32;

            let top = v00 * (1.0 - wx) + v10 * wx;
            let bot = v01 * (1.0 - wx) + v11 * wx;
            let out = top * (1.0 - wy) + bot * wy;

            dst[row_idx + x] = out.round().clamp(0.0, 255.0) as u8;
        }
    }

    dst
}

/// Compute 3x3 Sobel spatial gradient magnitude and quantized orientation bins [0..7].
/// Orientation bin 0 = ~0°, 1 = ~45°, 2 = ~90°, ..., 7 = ~315°.
pub fn compute_sobel_gradients(src: &[u8], width: u32, height: u32) -> (Vec<u8>, Vec<u8>) {
    let w = width as usize;
    let h = height as usize;
    let mut mag = vec![0u8; w * h];
    let mut ori = vec![0u8; w * h];

    if w < 3 || h < 3 {
        return (mag, ori);
    }

    for y in 1..(h - 1) {
        let r_prev = (y - 1) * w;
        let r_curr = y * w;
        let r_next = (y + 1) * w;

        for x in 1..(w - 1) {
            // Sobel X kernel:
            // -1  0  1
            // -2  0  2
            // -1  0  1
            let gx = -(src[r_prev + x - 1] as i32) + (src[r_prev + x + 1] as i32)
                - 2 * (src[r_curr + x - 1] as i32) + 2 * (src[r_curr + x + 1] as i32)
                - (src[r_next + x - 1] as i32) + (src[r_next + x + 1] as i32);

            // Sobel Y kernel:
            // -1 -2 -1
            //  0  0  0
            //  1  2  1
            let gy = -(src[r_prev + x - 1] as i32) - 2 * (src[r_prev + x] as i32) - (src[r_prev + x + 1] as i32)
                + (src[r_next + x - 1] as i32) + 2 * (src[r_next + x] as i32) + (src[r_next + x + 1] as i32);

            // Gradient magnitude normalized to [0, 255]
            let m = ((((gx * gx + gy * gy) as f32).sqrt()) * 0.25).round().min(255.0) as u8;
            mag[r_curr + x] = m;

            // Gradient orientation angle [-PI, PI] mapped to 8 sectors [0..7]
            if m > 12 {
                let angle = (gy as f32).atan2(gx as f32); // [-PI, PI]
                let norm_angle = if angle < 0.0 { angle + 2.0 * std::f32::consts::PI } else { angle };
                let bin = ((norm_angle / (2.0 * std::f32::consts::PI) * 8.0).round() as usize) % 8;
                ori[r_curr + x] = bin as u8;
            } else {
                ori[r_curr + x] = 0;
            }
        }
    }

    (mag, ori)
}

/// Downsamples a grayscale image by a factor of 2x using 2x2 box area averaging.
/// This prevents aliasing and produces high-quality image pyramid steps.
pub fn downsample_2x(src: &[u8], src_w: u32, src_h: u32) -> (Vec<u8>, u32, u32) {
    let dst_w = (src_w / 2).max(1);
    let dst_h = (src_h / 2).max(1);
    let mut dst = vec![0u8; (dst_w * dst_h) as usize];

    for y in 0..dst_h {
        let sy0 = (y * 2) as usize;
        let sy1 = ((y * 2 + 1) as usize).min((src_h - 1) as usize);
        let src_row0 = sy0 * (src_w as usize);
        let src_row1 = sy1 * (src_w as usize);
        let dst_row = (y as usize) * (dst_w as usize);

        for x in 0..dst_w {
            let sx0 = (x * 2) as usize;
            let sx1 = ((x * 2 + 1) as usize).min((src_w - 1) as usize);

            let p00 = src[src_row0 + sx0] as u32;
            let p10 = src[src_row0 + sx1] as u32;
            let p01 = src[src_row1 + sx0] as u32;
            let p11 = src[src_row1 + sx1] as u32;

            let avg = (p00 + p10 + p01 + p11 + 2) / 4;
            dst[dst_row + (x as usize)] = avg as u8;
        }
    }

    (dst, dst_w, dst_h)
}

/// Generates a multi-scale pyramid with CLAHE local contrast normalization and Sobel gradients.
pub fn build_grayscale_pyramid(gray_base: &[u8], width: u32, height: u32, max_levels: usize) -> Vec<PyramidLevel> {
    let mut levels = Vec::new();

    // Apply CLAHE on level 0 for local illumination equalization
    let clahe_base = apply_clahe(gray_base, width, height, 8, 8, 2.5);
    let (mag0, ori0) = compute_sobel_gradients(&clahe_base, width, height);

    levels.push(PyramidLevel {
        level: 0,
        width,
        height,
        scale: 1.0,
        pixels: clahe_base.clone(),
        grad_magnitude: mag0,
        grad_orientation: ori0,
    });

    let mut current_pixels = clahe_base;
    let mut curr_w = width;
    let mut curr_h = height;
    let mut curr_scale = 1.0f32;

    for lvl in 1..max_levels {
        if curr_w <= 16 || curr_h <= 16 {
            break;
        }
        let (downscaled, next_w, next_h) = downsample_2x(&current_pixels, curr_w, curr_h);
        curr_scale *= 0.5;

        let (g_mag, g_ori) = compute_sobel_gradients(&downscaled, next_w, next_h);

        levels.push(PyramidLevel {
            level: lvl,
            width: next_w,
            height: next_h,
            scale: curr_scale,
            pixels: downscaled.clone(),
            grad_magnitude: g_mag,
            grad_orientation: g_ori,
        });
        current_pixels = downscaled;
        curr_w = next_w;
        curr_h = next_h;
    }

    levels
}

/// Computes slot layout and nominal geometry for the puzzle grid.
pub fn compute_slot_grid(
    cols: u32,
    rows: u32,
    img_w: u32,
    img_h: u32,
    phys_w_mm: f32,
    phys_h_mm: f32,
) -> Vec<PosterSlot> {
    let mut slots = Vec::with_capacity((cols * rows) as usize);
    if cols == 0 || rows == 0 || img_w == 0 || img_h == 0 {
        return slots;
    }

    let cell_w_px = (img_w as f32) / (cols as f32);
    let cell_h_px = (img_h as f32) / (rows as f32);
    let cell_w_mm = if cols > 0 { phys_w_mm / (cols as f32) } else { 0.0 };
    let cell_h_mm = if rows > 0 { phys_h_mm / (rows as f32) } else { 0.0 };

    for r in 0..rows {
        for c in 0..cols {
            let min_x_px = (c as f32) * cell_w_px;
            let min_y_px = (r as f32) * cell_h_px;
            let max_x_px = min_x_px + cell_w_px;
            let max_y_px = min_y_px + cell_h_px;
            let center_x_px = min_x_px + cell_w_px * 0.5;
            let center_y_px = min_y_px + cell_h_px * 0.5;

            let center_x_mm = (c as f32 + 0.5) * cell_w_mm;
            let center_y_mm = (r as f32 + 0.5) * cell_h_mm;

            let (is_border, is_corner) = classify_grid_cell(r, c, rows, cols);

            slots.push(PosterSlot {
                col: c,
                row: r,
                min_x_px,
                min_y_px,
                max_x_px,
                max_y_px,
                center_x_px,
                center_y_px,
                center_x_mm,
                center_y_mm,
                is_border,
                is_corner,
            });
        }
    }

    slots
}

/// Convert sRGB [0..255] to CIELAB (D65 illuminant).
pub fn rgb_to_cielab(r: u8, g: u8, b: u8) -> [f32; 3] {
    // 1. sRGB to linear RGB via precomputed lookup table
    let lr = SRGB_TO_LINEAR_LUT[r as usize];
    let lg = SRGB_TO_LINEAR_LUT[g as usize];
    let lb = SRGB_TO_LINEAR_LUT[b as usize];

    // 2. Linear RGB to XYZ
    let x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
    let y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
    let z = lr * 0.0193339 + lg * 0.119_192 + lb * 0.9503041;

    // 3. XYZ to CIELAB with D65 reference white (Xn=0.95047, Yn=1.00000, Zn=1.08883)
    let f = |t: f32| -> f32 {
        let delta = 6.0 / 29.0;
        if t > delta * delta * delta {
            t.cbrt()
        } else {
            t / (3.0 * delta * delta) + 4.0 / 29.0
        }
    };

    let fx = f(x / 0.95047);
    let fy = f(y / 1.00000);
    let fz = f(z / 1.08883);

    let l_star = (116.0 * fy - 16.0).max(0.0);
    let a_star = 500.0 * (fx - fy);
    let b_star = 200.0 * (fy - fz);

    [l_star, a_star, b_star]
}

/// Extracts a high-resolution RGBA slot thumbnail and computes mean RGB and CIELAB color cues
/// for Mode C (Targeted Hole-Filling).
pub fn extract_slot_preview(
    rgba: &[u8],
    img_w: u32,
    img_h: u32,
    cols: u32,
    rows: u32,
    col: u32,
    row: u32,
) -> Result<SlotPreview, String> {
    if col >= cols || row >= rows {
        return Err(format!("Slot [{}, {}] is out of bounds for grid {}x{}", col, row, cols, rows));
    }
    let cell_w = (img_w as f32 / cols as f32).round() as u32;
    let cell_h = (img_h as f32 / rows as f32).round() as u32;

    let x0 = (col as f32 * (img_w as f32 / cols as f32)).round() as u32;
    let y0 = (row as f32 * (img_h as f32 / rows as f32)).round() as u32;
    let x1 = (x0 + cell_w).min(img_w);
    let y1 = (y0 + cell_h).min(img_h);

    let crop_w = x1 - x0;
    let crop_h = y1 - y0;
    let mut crop_rgba = vec![0u8; (crop_w * crop_h * 4) as usize];

    let mut sum_r = 0u64;
    let mut sum_g = 0u64;
    let mut sum_b = 0u64;
    let mut count = 0u64;

    for y in 0..crop_h {
        let src_y = y0 + y;
        let src_row = (src_y * img_w) as usize;
        let dst_row = (y * crop_w) as usize;

        for x in 0..crop_w {
            let src_x = x0 + x;
            let src_idx = (src_row + (src_x as usize)) * 4;
            let dst_idx = (dst_row + (x as usize)) * 4;

            let r = rgba[src_idx];
            let g = rgba[src_idx + 1];
            let b = rgba[src_idx + 2];
            let a = rgba[src_idx + 3];

            crop_rgba[dst_idx] = r;
            crop_rgba[dst_idx + 1] = g;
            crop_rgba[dst_idx + 2] = b;
            crop_rgba[dst_idx + 3] = a;

            sum_r += r as u64;
            sum_g += g as u64;
            sum_b += b as u64;
            count += 1;
        }
    }

    let mean_r = sum_r.checked_div(count).unwrap_or(0) as u8;
    let mean_g = sum_g.checked_div(count).unwrap_or(0) as u8;
    let mean_b = sum_b.checked_div(count).unwrap_or(0) as u8;

    let lab = rgb_to_cielab(mean_r, mean_g, mean_b);

    let (is_border, is_corner) = classify_grid_cell(row, col, rows, cols);

    Ok(SlotPreview {
        col,
        row,
        width: crop_w,
        height: crop_h,
        is_border,
        is_corner,
        rgba_crop: crop_rgba,
        mean_rgb: [mean_r, mean_g, mean_b],
        mean_lab: lab,
    })
}

/// Ingests a master reference poster RGBA buffer and generates the precomputed multi-scale pyramid.
pub fn ingest_poster_buffer(
    rgba: &[u8],
    width: u32,
    height: u32,
    total_pieces: u32,
    cols: u32,
    rows: u32,
    phys_w_mm: f32,
    phys_h_mm: f32,
    max_pyramid_levels: usize,
) -> Result<MasterPoster, String> {
    if width == 0 || height == 0 {
        return Err("Invalid poster dimensions (width and height must be > 0)".to_string());
    }
    let expected_rgba_len = (width * height * 4) as usize;
    if rgba.len() < expected_rgba_len {
        return Err(format!(
            "RGBA buffer length {} is smaller than expected {} ({}x{}x4)",
            rgba.len(),
            expected_rgba_len,
            width,
            height
        ));
    }

    let gray = rgba_to_grayscale(rgba, width, height);
    let pyramids = build_grayscale_pyramid(&gray, width, height, max_pyramid_levels);

    let cell_w_px = if cols > 0 { (width as f32) / (cols as f32) } else { 0.0 };
    let cell_h_px = if rows > 0 { (height as f32) / (rows as f32) } else { 0.0 };
    let cell_w_mm = if cols > 0 { phys_w_mm / (cols as f32) } else { 0.0 };
    let cell_h_mm = if rows > 0 { phys_h_mm / (rows as f32) } else { 0.0 };

    let metadata = PosterMetadata {
        total_pieces,
        grid_cols: cols,
        grid_rows: rows,
        physical_width_mm: phys_w_mm,
        physical_height_mm: phys_h_mm,
        original_width_px: width,
        original_height_px: height,
        cell_width_px: cell_w_px,
        cell_height_px: cell_h_px,
        cell_width_mm: cell_w_mm,
        cell_height_mm: cell_h_mm,
    };

    Ok(MasterPoster { metadata, pyramids })
}

/// WASM entry point: Ingests an RGBA poster image buffer, computes metadata and multi-scale pyramids,
/// and returns the serialized MasterPoster structure.
#[wasm_bindgen]
pub fn process_poster_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    total_pieces: u32,
    cols: u32,
    rows: u32,
    phys_w_mm: f32,
    phys_h_mm: f32,
    max_pyramid_levels: usize,
) -> Result<JsValue, JsValue> {
    let poster = ingest_poster_buffer(
        rgba,
        width,
        height,
        total_pieces,
        cols,
        rows,
        phys_w_mm,
        phys_h_mm,
        max_pyramid_levels,
    ).map_err(|e| JsValue::from_str(&e))?;

    serde_wasm_bindgen::to_value(&poster).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// WASM entry point: Computes the grid slots layout.
#[wasm_bindgen]
pub fn get_poster_grid_slots(
    cols: u32,
    rows: u32,
    img_w: u32,
    img_h: u32,
    phys_w_mm: f32,
    phys_h_mm: f32,
) -> Result<JsValue, JsValue> {
    let slots = compute_slot_grid(cols, rows, img_w, img_h, phys_w_mm, phys_h_mm);
    serde_wasm_bindgen::to_value(&slots).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// WASM entry point: Extracts a high-resolution slot thumbnail and color cue metadata for Mode C (Targeted Hole-Filling).
#[wasm_bindgen]
pub fn get_slot_preview(
    rgba: &[u8],
    img_w: u32,
    img_h: u32,
    cols: u32,
    rows: u32,
    col: u32,
    row: u32,
) -> Result<JsValue, JsValue> {
    let preview = extract_slot_preview(rgba, img_w, img_h, cols, rows, col, row)
        .map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&preview).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Output match candidate from poster localization search.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CandidatePosterSlot {
    pub col: u32,
    pub row: u32,
    pub rotation_deg: f32, // 0, 90, 180, 270
    pub confidence: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PiecePosterMatch {
    pub best_col: u32,
    pub best_row: u32,
    pub best_rotation_deg: f32,
    pub confidence: f32,
    pub top_candidates: Vec<CandidatePosterSlot>,
}

/// Compute average CIELAB chrominance and 8-bin Sobel gradient histogram for an RGBA image buffer.
/// If `mask` is provided (e.g. from piece contour segmentation), only pixels where `mask[i] > 128`
/// are sampled, completely ignoring the surrounding white staging arena paper.
pub fn extract_visual_fingerprint(
    rgba: &[u8],
    mask: Option<&[u8]>,
    width: u32,
    height: u32,
) -> ([f32; 3], [f32; 8]) {
    let pixel_count = (width * height) as usize;
    if pixel_count == 0 || rgba.len() < pixel_count * 4 {
        return ([50.0, 0.0, 0.0], [0.125; 8]);
    }

    // 1. Mean CIELAB
    let mut sum_l = 0.0f32;
    let mut sum_a = 0.0f32;
    let mut sum_b = 0.0f32;

    let step = (pixel_count / 1500).max(1);
    let mut sampled_count = 0.0f32;

    for i in (0..pixel_count).step_by(step) {
        // If a segmentation mask is supplied, only accept piece foreground pixels
        if let Some(m) = mask
            && i < m.len() && m[i] < 128 {
                continue;
            }
        let alpha = rgba[i * 4 + 3];
        if alpha < 50 {
            continue; // Skip transparent
        }
        let r = rgba[i * 4];
        let g = rgba[i * 4 + 1];
        let b = rgba[i * 4 + 2];
        let lab = rgb_to_cielab(r, g, b);
        sum_l += lab[0];
        sum_a += lab[1];
        sum_b += lab[2];
        sampled_count += 1.0;
    }

    let mean_lab = if sampled_count > 0.0 {
        [sum_l / sampled_count, sum_a / sampled_count, sum_b / sampled_count]
    } else {
        [50.0, 0.0, 0.0]
    };

    // 2. Grayscale + Sobel 8-bin gradient orientation histogram
    let gray = rgba_to_grayscale(rgba, width, height);
    let clahe_gray = apply_clahe(&gray, width, height, 4, 4, 2.0);
    let (mag, ori) = compute_sobel_gradients(&clahe_gray, width, height);

    let mut ori_hist = [0.0f32; 8];
    let mut total_grad = 0.0f32;

    for i in 0..pixel_count {
        if let Some(m) = mask
            && i < m.len() && m[i] < 128 {
                continue;
            }
        let m = mag[i] as f32;
        if m > 15.0 {
            let bin = (ori[i] as usize).min(7);
            ori_hist[bin] += m;
            total_grad += m;
        }
    }

    if total_grad > 0.0 {
        for val in &mut ori_hist {
            *val /= total_grad;
        }
    } else {
        ori_hist.fill(0.125);
    }

    (mean_lab, ori_hist)
}

/// Rotates an 8-bin gradient histogram by 90-degree increments (k = 0, 1, 2, 3).
/// Since 8 bins span 360° (45° per bin), each 90° rotation shifts the histogram by 2 bins.
pub fn rotate_gradient_histogram(hist: &[f32; 8], k: usize) -> [f32; 8] {
    let shift = (k * 2) % 8;
    let mut rotated = [0.0f32; 8];
    for i in 0..8 {
        rotated[(i + shift) % 8] = hist[i];
    }
    rotated
}

/// Fast similarity metric combining CIELAB chromaticity distance (ΔE) and Gradient Histogram cosine similarity.
pub fn compute_slot_similarity(
    piece_lab: &[f32; 3],
    piece_hist: &[f32; 8],
    slot_lab: &[f32; 3],
    slot_hist: &[f32; 8],
) -> f32 {
    // 1. CIELAB distance: chromaticity (a*, b*) has higher weight than L* (since lighting finish varies)
    let dl = (piece_lab[0] - slot_lab[0]) * 0.4;
    let da = piece_lab[1] - slot_lab[1];
    let db = piece_lab[2] - slot_lab[2];
    let delta_e = (dl * dl + da * da + db * db).sqrt(); // 0 to ~150
    let color_score = (1.0 - (delta_e / 70.0)).clamp(0.0, 1.0);

    // 2. Cosine similarity between gradient orientation histograms
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for i in 0..8 {
        dot += piece_hist[i] * slot_hist[i];
        norm_a += piece_hist[i] * piece_hist[i];
        norm_b += slot_hist[i] * slot_hist[i];
    }
    let grad_score = if norm_a > 0.0 && norm_b > 0.0 {
        (dot / (norm_a.sqrt() * norm_b.sqrt())).clamp(0.0, 1.0)
    } else {
        0.5
    };

    // Weighted fusion: 55% color/chromaticity + 45% structural edge orientation
    0.55 * color_score + 0.45 * grad_score
}

/// Precomputed visual descriptor for a single poster grid slot.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PrecomputedSlotDescriptor {
    pub col: u32,
    pub row: u32,
    pub mean_lab: [f32; 3],
    pub grad_hist: [f32; 8],
    pub is_border: bool,
    pub is_corner: bool,
}

/// Precomputes visual descriptors (CIELAB color & Sobel orientation histogram) for all grid slots
/// once when poster is ingested, eliminating per-frame convolutions.
#[wasm_bindgen]
pub fn precompute_poster_slots(
    poster_rgba: &[u8],
    poster_w: u32,
    poster_h: u32,
    cols: u32,
    rows: u32,
) -> Result<JsValue, JsValue> {
    if cols == 0 || rows == 0 || poster_w == 0 || poster_h == 0 {
        return Err(JsValue::from_str("Invalid dimensions for poster precomputation"));
    }

    let cell_w = (poster_w as f32 / cols as f32).round() as usize;
    let cell_h = (poster_h as f32 / rows as f32).round() as usize;

    let mut descriptors: Vec<PrecomputedSlotDescriptor> = Vec::with_capacity((cols * rows) as usize);
    let mut slot_rgba = Vec::with_capacity(cell_w * cell_h * 4);

    for r in 0..rows {
        for c in 0..cols {
            let (is_border, is_corner) = classify_grid_cell(r, c, rows, cols);

            let x0 = (c as f32 * (poster_w as f32 / cols as f32)) as usize;
            let y0 = (r as f32 * (poster_h as f32 / rows as f32)) as usize;
            let sub_w = cell_w.min(poster_w as usize - x0);
            let sub_h = cell_h.min(poster_h as usize - y0);

            if sub_w < 4 || sub_h < 4 {
                descriptors.push(PrecomputedSlotDescriptor {
                    col: c,
                    row: r,
                    mean_lab: [50.0, 0.0, 0.0],
                    grad_hist: [0.125; 8],
                    is_border,
                    is_corner,
                });
                continue;
            }

            let needed = sub_w * sub_h * 4;
            slot_rgba.resize(needed, 0);
            for sy in 0..sub_h {
                let src_idx = ((y0 + sy) * (poster_w as usize) + x0) * 4;
                let dst_idx = sy * sub_w * 4;
                let len = sub_w * 4;
                if src_idx + len <= poster_rgba.len() {
                    slot_rgba[dst_idx..dst_idx + len].copy_from_slice(&poster_rgba[src_idx..src_idx + len]);
                }
            }

            let (slot_lab, slot_hist) = extract_visual_fingerprint(&slot_rgba, None, sub_w as u32, sub_h as u32);
            descriptors.push(PrecomputedSlotDescriptor {
                col: c,
                row: r,
                mean_lab: slot_lab,
                grad_hist: slot_hist,
                is_border,
                is_corner,
            });
        }
    }

    serde_wasm_bindgen::to_value(&descriptors).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Fast candidate search running against precomputed slot descriptors in < 2ms.
#[wasm_bindgen]
pub fn locate_piece_fast(
    piece_rgba: &[u8],
    piece_mask: &[u8],
    piece_w: u32,
    piece_h: u32,
    precomputed_slots_json: JsValue,
    is_border_hint: bool,
    is_corner_hint: bool,
) -> Result<JsValue, JsValue> {
    if piece_w == 0 || piece_h == 0 {
        return Err(JsValue::from_str("Invalid piece dimensions"));
    }

    let descriptors: Vec<PrecomputedSlotDescriptor> = serde_wasm_bindgen::from_value(precomputed_slots_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse descriptors: {}", e)))?;

    let mask_opt = if !piece_mask.is_empty() { Some(piece_mask) } else { None };
    let (piece_lab, piece_hist) = extract_visual_fingerprint(piece_rgba, mask_opt, piece_w, piece_h);

    let rotations_deg = [0.0f32, 90.0f32, 180.0f32, 270.0f32];
    let rot_hists: [[f32; 8]; 4] = [
        rotate_gradient_histogram(&piece_hist, 0),
        rotate_gradient_histogram(&piece_hist, 1),
        rotate_gradient_histogram(&piece_hist, 2),
        rotate_gradient_histogram(&piece_hist, 3),
    ];

    let mut scored_slots: Vec<CandidatePosterSlot> = Vec::with_capacity(descriptors.len());

    // Literature Constraint Satisfaction Problem (CSP) Topological Domain Partitioning:
    // A piece with 0 flat edges is strictly interior; 1 flat edge is strictly border; 2 flat edges is strictly corner.
    // Rather than scaling similarity scores with arbitrary numbers, filter the search domain directly.
    for desc in &descriptors {
        if is_corner_hint {
            if !desc.is_corner {
                continue;
            }
        } else if is_border_hint {
            if !desc.is_border || desc.is_corner {
                continue;
            }
        } else {
            // Interior piece: strictly exclude borders and corners
            if desc.is_border || desc.is_corner {
                continue;
            }
        }

        let mut best_rot = 0.0f32;
        let mut max_sim = 0.0f32;

        for (k, &rot_deg) in rotations_deg.iter().enumerate() {
            let sim = compute_slot_similarity(&piece_lab, &rot_hists[k], &desc.mean_lab, &desc.grad_hist);
            if sim > max_sim {
                max_sim = sim;
                best_rot = rot_deg;
            }
        }

        scored_slots.push(CandidatePosterSlot {
            col: desc.col,
            row: desc.row,
            rotation_deg: best_rot,
            confidence: max_sim.min(1.0),
        });
    }

    scored_slots.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    let top_candidates: Vec<CandidatePosterSlot> = scored_slots.iter().take(5).cloned().collect();

    let (best_col, best_row, best_rotation_deg, confidence) = if let Some(best) = top_candidates.first() {
        (best.col, best.row, best.rotation_deg, best.confidence)
    } else {
        (0, 0, 0.0, 0.0)
    };

    let result = PiecePosterMatch {
        best_col,
        best_row,
        best_rotation_deg,
        confidence,
        top_candidates,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

// ----------------- Milestone 1: 4x4 Spatial Pyramid Engine -----------------

/// A single cell in a 4x4 spatial layout grid (16 cells total).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SpatialCell {
    pub mean_lab: [f32; 3],
    pub grad_hist: [f32; 8],
    pub sample_count: u32,
}

/// Precomputed spatial layout descriptor for a poster slot with overlapping receptive field.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SpatialSlotDescriptor {
    pub col: u32,
    pub row: u32,
    pub is_border: bool,
    pub is_corner: bool,
    pub cells: [SpatialCell; 16],
}

/// Extracts a 4x4 spatial grid of CIELAB and Sobel gradient histograms from an image ROI
/// using precomputed full-image gradient magnitude and orientation buffers.
pub fn extract_spatial_grid_precomputed(
    rgba: &[u8],
    width: u32,
    height: u32,
    mag: &[u8],
    ori: &[u8],
    mask: Option<&[u8]>,
    roi_x0: u32,
    roi_y0: u32,
    roi_w: u32,
    roi_h: u32,
) -> [SpatialCell; 16] {
    let mut cells: [SpatialCell; 16] = std::array::from_fn(|_| SpatialCell {
        mean_lab: [50.0, 0.0, 0.0],
        grad_hist: [0.125; 8],
        sample_count: 0,
    });

    let w = width as usize;
    let h = height as usize;
    if w == 0 || h == 0 || roi_w == 0 || roi_h == 0 {
        return cells;
    }

    let cell_w_f = roi_w as f32 / 4.0;
    let cell_h_f = roi_h as f32 / 4.0;

    let mut sum_l = [0.0f32; 16];
    let mut sum_a = [0.0f32; 16];
    let mut sum_b = [0.0f32; 16];
    let mut count = [0u32; 16];
    let mut grad_hist = [[0.0f32; 8]; 16];
    let mut total_grad = [0.0f32; 16];

    let x_end = (roi_x0 + roi_w).min(width);
    let y_end = (roi_y0 + roi_h).min(height);

    for y in roi_y0..y_end {
        let gy = (((y - roi_y0) as f32 / cell_h_f).floor() as usize).min(3);
        let row_idx = (y as usize) * w;

        for x in roi_x0..x_end {
            let gx = (((x - roi_x0) as f32 / cell_w_f).floor() as usize).min(3);
            let cell_idx = gy * 4 + gx;
            let pix_idx = row_idx + (x as usize);

            if let Some(m) = mask
                && pix_idx < m.len() && m[pix_idx] < 128 {
                    continue;
                }

            let byte_idx = pix_idx * 4;
            if byte_idx + 3 >= rgba.len() {
                continue;
            }

            let alpha = rgba[byte_idx + 3];
            if alpha < 50 {
                continue;
            }

            let r = rgba[byte_idx];
            let g = rgba[byte_idx + 1];
            let b = rgba[byte_idx + 2];
            let lab = rgb_to_cielab(r, g, b);

            sum_l[cell_idx] += lab[0];
            sum_a[cell_idx] += lab[1];
            sum_b[cell_idx] += lab[2];
            count[cell_idx] += 1;

            if pix_idx < mag.len() && pix_idx < ori.len() {
                let m_val = mag[pix_idx] as f32;
                if m_val > 12.0 {
                    let bin = (ori[pix_idx] as usize).min(7);
                    grad_hist[cell_idx][bin] += m_val;
                    total_grad[cell_idx] += m_val;
                }
            }
        }
    }

    for i in 0..16 {
        let cnt = count[i];
        let mean_lab = if cnt > 0 {
            [sum_l[i] / cnt as f32, sum_a[i] / cnt as f32, sum_b[i] / cnt as f32]
        } else {
            [50.0, 0.0, 0.0]
        };

        let mut hist = [0.125f32; 8];
        let tg = total_grad[i];
        if tg > 0.0 {
            for b in 0..8 {
                hist[b] = grad_hist[i][b] / tg;
            }
        }

        cells[i] = SpatialCell {
            mean_lab,
            grad_hist: hist,
            sample_count: cnt,
        };
    }

    cells
}

/// Rotates a 4x4 spatial grid by k clockwise 90-degree increments (k = 0, 1, 2, 3).
/// Maps cell (r, c) -> (c, 3 - r) for 90 deg clockwise, and rotates gradient bins by 2k.
pub fn rotate_spatial_grid(cells: &[SpatialCell; 16], k: usize) -> [SpatialCell; 16] {
    if k.is_multiple_of(4) {
        return cells.clone();
    }
    let mut rotated = cells.clone();
    let shift = (k * 2) % 8;

    for r in 0..4 {
        for c in 0..4 {
            let (dst_r, dst_c) = match k % 4 {
                1 => (c, 3 - r),
                2 => (3 - r, 3 - c),
                3 => (3 - c, r),
                _ => (r, c),
            };
            let dst_idx = dst_r * 4 + dst_c;
            let src_idx = r * 4 + c;

            let mut rot_hist = [0.0f32; 8];
            for b in 0..8 {
                rot_hist[(b + shift) % 8] = cells[src_idx].grad_hist[b];
            }

            rotated[dst_idx] = SpatialCell {
                mean_lab: cells[src_idx].mean_lab,
                grad_hist: rot_hist,
                sample_count: cells[src_idx].sample_count,
            };
        }
    }
    rotated
}

/// Computes multi-cell similarity across all 16 spatial cells in the 4x4 grid.
/// Combines illumination-invariant relative spatial color contrast and centered Sobel gradient orientation.
pub fn compute_spatial_similarity(
    piece_cells: &[SpatialCell; 16],
    slot_cells: &[SpatialCell; 16],
) -> f32 {
    let mut p_sum_l = 0.0f32;
    let mut p_sum_a = 0.0f32;
    let mut p_sum_b = 0.0f32;
    let mut p_valid_cells = 0f32;

    let mut s_sum_l = 0.0f32;
    let mut s_sum_a = 0.0f32;
    let mut s_sum_b = 0.0f32;
    let mut s_valid_cells = 0f32;

    for i in 0..16 {
        let pc = &piece_cells[i];
        let sc = &slot_cells[i];
        if pc.sample_count > 0 {
            p_sum_l += pc.mean_lab[0];
            p_sum_a += pc.mean_lab[1];
            p_sum_b += pc.mean_lab[2];
            p_valid_cells += 1.0;
        }
        if sc.sample_count > 0 {
            s_sum_l += sc.mean_lab[0];
            s_sum_a += sc.mean_lab[1];
            s_sum_b += sc.mean_lab[2];
            s_valid_cells += 1.0;
        }
    }

    if p_valid_cells == 0.0 || s_valid_cells == 0.0 {
        return 0.0;
    }

    let p_mean_l = p_sum_l / p_valid_cells;
    let p_mean_a = p_sum_a / p_valid_cells;
    let p_mean_b = p_sum_b / p_valid_cells;

    let s_mean_l = s_sum_l / s_valid_cells;
    let s_mean_a = s_sum_a / s_valid_cells;
    let s_mean_b = s_sum_b / s_valid_cells;

    // 1. Global chromaticity distance:
    // L* has 0.30 weight (robust against ambient room dimming)
    // a* and b* have full 1.0 weight (preserves distinct chromatic identity: blue vs gray vs red)
    let mean_dl = (p_mean_l - s_mean_l) * 0.30;
    let mean_da = p_mean_a - s_mean_a;
    let mean_db = p_mean_b - s_mean_b;
    let global_delta_e = (mean_dl * mean_dl + mean_da * mean_da + mean_db * mean_db).sqrt();
    let global_color_score = (1.0 - (global_delta_e / 40.0)).clamp(0.0, 1.0);

    let mut total_sim = 0.0f32;
    let mut valid_weight = 0.0f32;

    for i in 0..16 {
        let pc = &piece_cells[i];
        let sc = &slot_cells[i];

        if pc.sample_count == 0 {
            continue;
        }
        let weight = 1.0f32;

        // 2. Relative spatial color pattern: measures internal gradient of colors across the 16 cells
        // Invariant to room illumination and global white balance shifts
        let p_rel_l = pc.mean_lab[0] - p_mean_l;
        let p_rel_a = pc.mean_lab[1] - p_mean_a;
        let p_rel_b = pc.mean_lab[2] - p_mean_b;

        let s_rel_l = sc.mean_lab[0] - s_mean_l;
        let s_rel_a = sc.mean_lab[1] - s_mean_a;
        let s_rel_b = sc.mean_lab[2] - s_mean_b;

        let d_rel_l = (p_rel_l - s_rel_l) * 0.5;
        let d_rel_a = p_rel_a - s_rel_a;
        let d_rel_b = p_rel_b - s_rel_b;
        let rel_delta_e = (d_rel_l * d_rel_l + d_rel_a * d_rel_a + d_rel_b * d_rel_b).sqrt();
        let rel_color_score = (1.0 - (rel_delta_e / 35.0)).clamp(0.0, 1.0);

        // 3. Centered gradient orientation similarity:
        // Subtract baseline 0.125 from histograms before dot product to eliminate diffuse/uniform inflation!
        // An untextured or flat cell has near-zero centered norm, avoiding high cosine scores against everything.
        let mut dot = 0.0f32;
        let mut norm_a = 0.0f32;
        let mut norm_b = 0.0f32;
        for b in 0..8 {
            let ha = pc.grad_hist[b] - 0.125;
            let hb = sc.grad_hist[b] - 0.125;
            dot += ha * hb;
            norm_a += ha * ha;
            norm_b += hb * hb;
        }
        let grad_score = if norm_a > 1e-4 && norm_b > 1e-4 {
            let cos_sim = dot / (norm_a.sqrt() * norm_b.sqrt());
            ((cos_sim + 1.0) * 0.5).clamp(0.0, 1.0)
        } else {
            0.5
        };

        // Tri-factor fusion: 45% spatial relative color + 35% global chromaticity + 20% gradient orientation
        let cell_score = 0.45 * rel_color_score + 0.35 * global_color_score + 0.20 * grad_score;
        total_sim += cell_score * weight;
        valid_weight += weight;
    }

    if valid_weight > 0.0 {
        total_sim / valid_weight
    } else {
        0.0
    }
}

/// Precomputes 4x4 spatial descriptors with overlapping receptive field margins (e.g. 1.35x)
/// to capture tabs protruding into neighboring cells.
pub fn precompute_spatial_poster_slots(
    poster_rgba: &[u8],
    poster_w: u32,
    poster_h: u32,
    cols: u32,
    rows: u32,
    margin_factor: f32,
) -> Vec<SpatialSlotDescriptor> {
    let mut descriptors = Vec::with_capacity((cols * rows) as usize);
    if cols == 0 || rows == 0 || poster_w == 0 || poster_h == 0 {
        return descriptors;
    }

    let gray = rgba_to_grayscale(poster_rgba, poster_w, poster_h);
    let clahe = apply_clahe(&gray, poster_w, poster_h, 8, 8, 2.0);
    let (mag, ori) = compute_sobel_gradients(&clahe, poster_w, poster_h);

    let cell_w_f = (poster_w as f32) / (cols as f32);
    let cell_h_f = (poster_h as f32) / (rows as f32);
    let exp_w_f = cell_w_f * margin_factor;
    let exp_h_f = cell_h_f * margin_factor;

    for r in 0..rows {
        for c in 0..cols {
            let (is_border, is_corner) = classify_grid_cell(r, c, rows, cols);

            let center_x = (c as f32 + 0.5) * cell_w_f;
            let center_y = (r as f32 + 0.5) * cell_h_f;

            let x0 = (center_x - exp_w_f * 0.5).max(0.0).round() as u32;
            let y0 = (center_y - exp_h_f * 0.5).max(0.0).round() as u32;
            let x1 = (center_x + exp_w_f * 0.5).min(poster_w as f32).round() as u32;
            let y1 = (center_y + exp_h_f * 0.5).min(poster_h as f32).round() as u32;

            let sub_w = (x1 - x0).max(4);
            let sub_h = (y1 - y0).max(4);

            let cells = extract_spatial_grid_precomputed(
                poster_rgba,
                poster_w,
                poster_h,
                &mag,
                &ori,
                None,
                x0,
                y0,
                sub_w,
                sub_h,
            );

            descriptors.push(SpatialSlotDescriptor {
                col: c,
                row: r,
                is_border,
                is_corner,
                cells,
            });
        }
    }

    descriptors
}

/// Warps a quadrilateral region defined by 4 corner points into an orthographic rectified patch.
pub fn warp_piece_core(
    src_rgba: &[u8],
    src_w: u32,
    src_h: u32,
    corners: &[f32],
    dst_w: u32,
    dst_h: u32,
) -> Option<Vec<u8>> {
    if corners.len() < 8 || src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return None;
    }
    let src_pts = [
        Point2D { x: corners[0], y: corners[1] },
        Point2D { x: corners[2], y: corners[3] },
        Point2D { x: corners[4], y: corners[5] },
        Point2D { x: corners[6], y: corners[7] },
    ];
    let dst_pts = [
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: dst_w as f32, y: 0.0 },
        Point2D { x: dst_w as f32, y: dst_h as f32 },
        Point2D { x: 0.0, y: dst_h as f32 },
    ];
    let h = Homography::from_4_points(&src_pts, &dst_pts)?;
    let inv_h = h.invert()?;

    let mut dst = vec![0u8; (dst_w * dst_h * 4) as usize];
    for y in 0..dst_h {
        let row_offset = (y * dst_w * 4) as usize;
        for x in 0..dst_w {
            let pt = inv_h.transform_point(Point2D { x: x as f32, y: y as f32 });
            let sx = (pt.x.round() as i32).clamp(0, src_w as i32 - 1) as u32;
            let sy = (pt.y.round() as i32).clamp(0, src_h as i32 - 1) as u32;
            let dst_idx = row_offset + (x * 4) as usize;
            let src_idx = ((sy * src_w + sx) * 4) as usize;
            if src_idx + 3 < src_rgba.len() {
                dst[dst_idx..dst_idx + 4].copy_from_slice(&src_rgba[src_idx..src_idx + 4]);
            }
        }
    }
    Some(dst)
}

/// Fallback extraction when 4-corner homography is not supplied (e.g. synthetic test patches)
fn fallback_extract_spatial_cells(
    piece_rgba: &[u8],
    piece_mask: &[u8],
    piece_w: u32,
    piece_h: u32,
) -> [SpatialCell; 16] {
    let mut fg_count = 0usize;
    let mut col_hist = vec![0u32; piece_w as usize];
    let mut row_hist = vec![0u32; piece_h as usize];

    if !piece_mask.is_empty() && piece_mask.len() >= (piece_w * piece_h) as usize {
        for y in 0..piece_h {
            let row_offset = (y * piece_w) as usize;
            for x in 0..piece_w {
                if piece_mask[row_offset + x as usize] > 128 {
                    col_hist[x as usize] += 1;
                    row_hist[y as usize] += 1;
                    fg_count += 1;
                }
            }
        }
    }

    let (roi_x0, roi_y0, roi_w, roi_h) = if fg_count > 100 {
        let thresh_count = (fg_count as f32 * 0.015).max(1.0) as u32;

        let mut min_x = 0u32;
        let mut cum_x = 0u32;
        for (x, &cnt) in col_hist.iter().enumerate() {
            cum_x += cnt;
            if cum_x >= thresh_count {
                min_x = x as u32;
                break;
            }
        }

        let mut max_x = piece_w.saturating_sub(1);
        cum_x = 0;
        for (x, &cnt) in col_hist.iter().enumerate().rev() {
            cum_x += cnt;
            if cum_x >= thresh_count {
                max_x = x as u32;
                break;
            }
        }

        let mut min_y = 0u32;
        let mut cum_y = 0u32;
        for (y, &cnt) in row_hist.iter().enumerate() {
            cum_y += cnt;
            if cum_y >= thresh_count {
                min_y = y as u32;
                break;
            }
        }

        let mut max_y = piece_h.saturating_sub(1);
        cum_y = 0;
        for (y, &cnt) in row_hist.iter().enumerate().rev() {
            cum_y += cnt;
            if cum_y >= thresh_count {
                max_y = y as u32;
                break;
            }
        }

        let min_x = min_x.saturating_sub(2);
        let min_y = min_y.saturating_sub(2);
        let max_x = (max_x + 2).min(piece_w.saturating_sub(1));
        let max_y = (max_y + 2).min(piece_h.saturating_sub(1));

        (min_x, min_y, (max_x - min_x + 1).max(4), (max_y - min_y + 1).max(4))
    } else {
        (0, 0, piece_w, piece_h)
    };

    let gray = rgba_to_grayscale(piece_rgba, piece_w, piece_h);
    let clahe = apply_clahe(&gray, piece_w, piece_h, 4, 4, 2.0);
    let (mag, ori) = compute_sobel_gradients(&clahe, piece_w, piece_h);

    let mask_opt = if !piece_mask.is_empty() { Some(piece_mask) } else { None };
    extract_spatial_grid_precomputed(
        piece_rgba,
        piece_w,
        piece_h,
        &mag,
        &ori,
        mask_opt,
        roi_x0,
        roi_y0,
        roi_w,
        roi_h,
    )
}

/// Core spatial piece localization against precomputed spatial slot descriptors.
/// Enforces geometric edge topology constraints (corner/border outer edges) and rectifies
/// physical piece orientation using sub-pixel corner homography.
pub fn locate_piece_spatial_core(
    piece_rgba: &[u8],
    piece_mask: &[u8],
    piece_w: u32,
    piece_h: u32,
    descriptors: &[SpatialSlotDescriptor],
    grid_cols: u32,
    grid_rows: u32,
    is_border_hint: bool,
    is_corner_hint: bool,
    corners: &[f32],
    flat_edges: &[u8],
) -> PiecePosterMatch {
    let patch_w = 48u32;
    let patch_h = 44u32;

    let piece_cells = if corners.len() >= 8 {
        if let Some(rectified) = warp_piece_core(piece_rgba, piece_w, piece_h, corners, patch_w, patch_h) {
            let gray = rgba_to_grayscale(&rectified, patch_w, patch_h);
            let clahe = apply_clahe(&gray, patch_w, patch_h, 4, 4, 2.0);
            let (mag, ori) = compute_sobel_gradients(&clahe, patch_w, patch_h);
            extract_spatial_grid_precomputed(
                &rectified,
                patch_w,
                patch_h,
                &mag,
                &ori,
                None,
                0,
                0,
                patch_w,
                patch_h,
            )
        } else {
            fallback_extract_spatial_cells(piece_rgba, piece_mask, piece_w, piece_h)
        }
    } else {
        fallback_extract_spatial_cells(piece_rgba, piece_mask, piece_w, piece_h)
    };

    let rot_grids = [
        rotate_spatial_grid(&piece_cells, 0),
        rotate_spatial_grid(&piece_cells, 1),
        rotate_spatial_grid(&piece_cells, 2),
        rotate_spatial_grid(&piece_cells, 3),
    ];
    let rotations_deg = [0.0f32, 90.0f32, 180.0f32, 270.0f32];

    let mut scored_slots: Vec<CandidatePosterSlot> = Vec::with_capacity(descriptors.len());
    let has_flat_info = flat_edges.len() >= 4;

    for desc in descriptors {
        // Enforce Geometric Edge Topology Constraints:
        // A piece's flat edges MUST align with the puzzle's outer borders!
        let (cand_rotations, cand_k): (Vec<f32>, Vec<usize>) = if is_corner_hint {
            if !desc.is_corner { continue; }
            if has_flat_info {
                // Determine required flat edges for this corner slot:
                // TL (0, 0): Top (0) and Left (3)
                // TR (0, cols-1): Top (0) and Right (1)
                // BL (rows-1, 0): Bottom (2) and Left (3)
                // BR (rows-1, cols-1): Bottom (2) and Right (1)
                let (req_a, req_b) = if desc.row == 0 && desc.col == 0 {
                    (0, 3)
                } else if desc.row == 0 && desc.col == grid_cols.saturating_sub(1) {
                    (0, 1)
                } else if desc.row == grid_rows.saturating_sub(1) && desc.col == 0 {
                    (2, 3)
                } else {
                    (2, 1)
                };

                let mut matched_k = None;
                for k in 0..4 {
                    let e_a = (req_a + 4 - k) % 4;
                    let e_b = (req_b + 4 - k) % 4;
                    if flat_edges[e_a] > 0 && flat_edges[e_b] > 0 {
                        matched_k = Some(k);
                        break;
                    }
                }

                if let Some(k) = matched_k {
                    (vec![rotations_deg[k]], vec![k])
                } else {
                    continue; // Geometrically impossible corner orientation
                }
            } else {
                (rotations_deg.to_vec(), (0..4).collect())
            }
        } else if is_border_hint {
            if !desc.is_border || desc.is_corner { continue; }
            if has_flat_info {
                // Determine required flat edge for this border slot:
                // Top border: Top (0)
                // Right border: Right (1)
                // Bottom border: Bottom (2)
                // Left border: Left (3)
                let req_edge = if desc.row == 0 {
                    0
                } else if desc.col == grid_cols.saturating_sub(1) {
                    1
                } else if desc.row == grid_rows.saturating_sub(1) {
                    2
                } else {
                    3
                };

                let mut matched_k = None;
                for k in 0..4 {
                    let e = (req_edge + 4 - k) % 4;
                    if flat_edges[e] > 0 {
                        matched_k = Some(k);
                        break;
                    }
                }

                if let Some(k) = matched_k {
                    (vec![rotations_deg[k]], vec![k])
                } else {
                    continue; // Geometrically impossible border orientation
                }
            } else {
                (rotations_deg.to_vec(), (0..4).collect())
            }
        } else {
            // Interior piece: strictly exclude borders and corners
            if desc.is_border || desc.is_corner { continue; }
            (rotations_deg.to_vec(), (0..4).collect())
        };

        let mut best_rot = 0.0f32;
        let mut max_sim = 0.0f32;

        for (idx, &k) in cand_k.iter().enumerate() {
            let sim = compute_spatial_similarity(&rot_grids[k], &desc.cells);
            if sim > max_sim {
                max_sim = sim;
                best_rot = cand_rotations[idx];
            }
        }

        if max_sim > 0.0 {
            scored_slots.push(CandidatePosterSlot {
                col: desc.col,
                row: desc.row,
                rotation_deg: best_rot,
                confidence: max_sim.min(1.0),
            });
        }
    }

    scored_slots.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    let top_candidates: Vec<CandidatePosterSlot> = scored_slots.iter().take(5).cloned().collect();

    let (best_col, best_row, best_rotation_deg, confidence) = if let Some(best) = top_candidates.first() {
        (best.col, best.row, best.rotation_deg, best.confidence)
    } else {
        (0, 0, 0.0, 0.0)
    };

    PiecePosterMatch {
        best_col,
        best_row,
        best_rotation_deg,
        confidence,
        top_candidates,
    }
}

// ----------------- Persistent WASM Heap Storage -----------------

pub struct PersistentPosterState {
    pub cols: u32,
    pub rows: u32,
    pub descriptors: Vec<SpatialSlotDescriptor>,
}

static PERSISTENT_POSTER: Mutex<Option<PersistentPosterState>> = Mutex::new(None);

/// WASM entry point: Ingests reference poster RGBA and stores precomputed 4x4 spatial descriptors
/// directly in Rust WebAssembly linear memory. Zero JSON serialization overhead!
#[wasm_bindgen]
pub fn init_master_poster_spatial(
    poster_rgba: &[u8],
    poster_w: u32,
    poster_h: u32,
    cols: u32,
    rows: u32,
) -> Result<u32, JsValue> {
    let descriptors = precompute_spatial_poster_slots(poster_rgba, poster_w, poster_h, cols, rows, 1.35);
    let count = descriptors.len() as u32;

    if let Ok(mut lock) = PERSISTENT_POSTER.lock() {
        *lock = Some(PersistentPosterState {
            cols,
            rows,
            descriptors,
        });
    } else {
        return Err(JsValue::from_str("Failed to acquire persistent poster lock"));
    }

    Ok(count)
}

/// WASM entry point: Locates a piece in < 3ms directly against resident WASM memory.
#[wasm_bindgen]
pub fn locate_piece_spatial(
    piece_rgba: &[u8],
    piece_mask: &[u8],
    piece_w: u32,
    piece_h: u32,
    is_border_hint: bool,
    is_corner_hint: bool,
    corners: &[f32],
    flat_edges: &[u8],
) -> Result<JsValue, JsValue> {
    if let Ok(lock) = PERSISTENT_POSTER.lock()
        && let Some(ref state) = *lock {
            let result = locate_piece_spatial_core(
                piece_rgba,
                piece_mask,
                piece_w,
                piece_h,
                &state.descriptors,
                state.cols,
                state.rows,
                is_border_hint,
                is_corner_hint,
                corners,
                flat_edges,
            );
            return serde_wasm_bindgen::to_value(&result)
                .map_err(|e| JsValue::from_str(&e.to_string()));
        }
    Err(JsValue::from_str("Master poster not initialized. Call init_master_poster_spatial first."))
}

// ---------------------------------------------------------------------------
// TRY-01 to TRY-05: Poster Pre-Sorting & Tray Clustering
// ---------------------------------------------------------------------------

pub const POSTER_TOTAL_COLS: u32 = 36;
pub const POSTER_TOTAL_ROWS: u32 = 28;
pub const POSTER_TOTAL_PIECES: u32 = 1008; // 36 * 28
pub const POSTER_BORDER_PIECES: u32 = 124; // 34*2 + 26*2 + 4
pub const POSTER_INTERIOR_PIECES: u32 = 884; // 34 * 26
pub const DEFAULT_MAX_CAPACITY: u32 = 125;
pub const NUM_TRAYS: usize = 8;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PosterSlotFeature {
    pub r: u32,
    pub c: u32,
    pub is_border: bool,
    pub is_corner: bool,
    pub lab: [f32; 3],
    pub gradient: f32,
    pub color_std: f32, // Rotation-invariant standard deviation of color in [0.0, 1.0]
    pub tray_id: u8, // 0 for border, 1..8 for interior trays
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TrayInfo {
    pub id: u8, // 1..8
    pub name: String,
    pub color: String,
    pub count: u32,
    pub max_capacity: u32, // 125
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClusteringStats {
    pub iterations: u32,
    pub max_iterations: u32,
    pub inertia: f32,
    pub is_balanced: bool,
    pub overflow_count: u32,
    pub compute_time_ms: u32,
    pub total_pieces: u32,    // 1008
    pub border_pieces: u32,   // 124
    pub interior_pieces: u32, // 884
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClusteringResult {
    pub slots: Vec<PosterSlotFeature>,
    pub trays: Vec<TrayInfo>,
    pub stats: ClusteringStats,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Centroid {
    pub lab: [f32; 3],
    pub gradient: f32,
    pub color_std: f32,
    pub r_norm: f32,
    pub c_norm: f32,
}

pub fn get_default_tray_definitions(max_capacity: u32) -> Vec<TrayInfo> {
    vec![
        TrayInfo { id: 1, name: "MEADOW".to_string(),  color: "#15803d".to_string(), count: 0, max_capacity },
        TrayInfo { id: 2, name: "SKY".to_string(),     color: "#0284c7".to_string(), count: 0, max_capacity },
        TrayInfo { id: 3, name: "BRICK".to_string(),   color: "#b45309".to_string(), count: 0, max_capacity },
        TrayInfo { id: 4, name: "STONE".to_string(),   color: "#6b7280".to_string(), count: 0, max_capacity },
        TrayInfo { id: 5, name: "FOREST".to_string(),  color: "#166534".to_string(), count: 0, max_capacity },
        TrayInfo { id: 6, name: "EARTH".to_string(),   color: "#7c2d12".to_string(), count: 0, max_capacity },
        TrayInfo { id: 7, name: "CANOPY".to_string(),  color: "#0f766e".to_string(), count: 0, max_capacity },
        TrayInfo { id: 8, name: "SHADOW".to_string(),  color: "#334155".to_string(), count: 0, max_capacity },
    ]
}

/// TRY-04: Deterministic 2x4 spatial grid partition for interior cells (default 28 rows, 36 cols)
pub fn get_spatial_seed_tray(r: u32, c: u32) -> u8 {
    get_spatial_seed_tray_grid(r, c, POSTER_TOTAL_ROWS, POSTER_TOTAL_COLS)
}

/// Dynamic 2x4 spatial grid partition for arbitrary puzzle grid dimensions
pub fn get_spatial_seed_tray_grid(r: u32, c: u32, rows: u32, cols: u32) -> u8 {
    if rows == POSTER_TOTAL_ROWS && cols == POSTER_TOTAL_COLS {
        let row_band = if r <= 13 { 0u8 } else { 1u8 };
        let col_band = if c <= 9 {
            0u8
        } else if c <= 18 {
            1u8
        } else if c <= 26 {
            2u8
        } else {
            3u8
        };
        row_band * 4 + col_band + 1
    } else {
        let row_band = if r < rows / 2 { 0u8 } else { 1u8 };
        let col_band = ((c as f32 / cols.max(1) as f32) * 4.0).clamp(0.0, 3.0) as u8;
        row_band * 4 + col_band + 1
    }
}

/// TRY-01: Extract feature vectors from an RGBA poster buffer for the default 1008-piece grid (36x28)
pub fn extract_poster_features(
    poster_rgba: &[u8],
    width: u32,
    height: u32,
) -> Vec<PosterSlotFeature> {
    extract_poster_features_grid(poster_rgba, width, height, POSTER_TOTAL_COLS, POSTER_TOTAL_ROWS)
}

/// Extract feature vectors from an RGBA poster buffer for arbitrary grid dimensions
pub fn extract_poster_features_grid(
    poster_rgba: &[u8],
    width: u32,
    height: u32,
    cols: u32,
    rows: u32,
) -> Vec<PosterSlotFeature> {
    let mut slots = Vec::with_capacity((cols * rows) as usize);
    let cell_w = width as f32 / cols.max(1) as f32;
    let cell_h = height as f32 / rows.max(1) as f32;

    for r in 0..rows {
        for c in 0..cols {
            let (is_border, is_corner) = classify_grid_cell(r, c, rows, cols);

            let x0 = c as f32 * cell_w;
            let y0 = r as f32 * cell_h;
            let x1 = (c + 1) as f32 * cell_w;
            let y1 = (r + 1) as f32 * cell_h;

            let crop_x0 = (x0 + 0.15 * cell_w).round() as u32;
            let crop_x1 = ((x1 - 0.15 * cell_w).round() as u32).max(crop_x0 + 1).min(width);
            let crop_y0 = (y0 + 0.15 * cell_h).round() as u32;
            let crop_y1 = ((y1 - 0.15 * cell_h).round() as u32).max(crop_y0 + 1).min(height);

            let mut sum_r = 0u64;
            let mut sum_g = 0u64;
            let mut sum_b = 0u64;
            let mut sum_sq_r = 0u64;
            let mut sum_sq_g = 0u64;
            let mut sum_sq_b = 0u64;
            let mut pixel_count = 0u32;
            let mut grad_sum = 0.0f32;
            let mut grad_count = 0u32;

            for y in crop_y0..crop_y1 {
                let row_idx = (y * width) as usize;
                for x in crop_x0..crop_x1 {
                    let idx = (row_idx + x as usize) * 4;
                    if idx + 3 < poster_rgba.len() {
                        let pr = poster_rgba[idx];
                        let pg = poster_rgba[idx + 1];
                        let pb = poster_rgba[idx + 2];

                        sum_r += pr as u64;
                        sum_g += pg as u64;
                        sum_b += pb as u64;
                        sum_sq_r += (pr as u64) * (pr as u64);
                        sum_sq_g += (pg as u64) * (pg as u64);
                        sum_sq_b += (pb as u64) * (pb as u64);
                        pixel_count += 1;

                        if x > 0 && x + 1 < width && y > 0 && y + 1 < height {
                            let p_l = rgb_to_luminance(
                                poster_rgba[((y * width + (x - 1)) * 4) as usize],
                                poster_rgba[((y * width + (x - 1)) * 4 + 1) as usize],
                                poster_rgba[((y * width + (x - 1)) * 4 + 2) as usize],
                            ) as f32;
                            let p_r = rgb_to_luminance(
                                poster_rgba[((y * width + (x + 1)) * 4) as usize],
                                poster_rgba[((y * width + (x + 1)) * 4 + 1) as usize],
                                poster_rgba[((y * width + (x + 1)) * 4 + 2) as usize],
                            ) as f32;
                            let p_u = rgb_to_luminance(
                                poster_rgba[(((y - 1) * width + x) * 4) as usize],
                                poster_rgba[(((y - 1) * width + x) * 4 + 1) as usize],
                                poster_rgba[(((y - 1) * width + x) * 4 + 2) as usize],
                            ) as f32;
                            let p_d = rgb_to_luminance(
                                poster_rgba[(((y + 1) * width + x) * 4) as usize],
                                poster_rgba[(((y + 1) * width + x) * 4 + 1) as usize],
                                poster_rgba[(((y + 1) * width + x) * 4 + 2) as usize],
                            ) as f32;

                            let gx = (p_r - p_l) * 0.5;
                            let gy = (p_d - p_u) * 0.5;
                            let mag = (gx * gx + gy * gy).sqrt();
                            grad_sum += mag;
                            grad_count += 1;
                        }
                    }
                }
            }

            let mean_r = if pixel_count > 0 { (sum_r / pixel_count as u64) as u8 } else { 128 };
            let mean_g = if pixel_count > 0 { (sum_g / pixel_count as u64) as u8 } else { 128 };
            let mean_b = if pixel_count > 0 { (sum_b / pixel_count as u64) as u8 } else { 128 };

            // Rotation-invariant core color standard deviation (variance across RGB channels):
            // Solid/smooth sky pieces have color_std near 0.0, textured/patterned foliage pieces have high std
            let color_std = if pixel_count > 1 {
                let n_f = pixel_count as f64;
                let var_r = (sum_sq_r as f64 / n_f) - (sum_r as f64 / n_f).powi(2);
                let var_g = (sum_sq_g as f64 / n_f) - (sum_g as f64 / n_f).powi(2);
                let var_b = (sum_sq_b as f64 / n_f) - (sum_b as f64 / n_f).powi(2);
                let mean_var = ((var_r.max(0.0) + var_g.max(0.0) + var_b.max(0.0)) / 3.0).sqrt();
                // Normalize by 64.0 into [0.0, 1.0]
                ((mean_var as f32) / 64.0).min(1.0)
            } else {
                0.0
            };

            let lab = rgb_to_cielab(mean_r, mean_g, mean_b);
            let gradient = if grad_count > 0 {
                // Sobel central difference with magnitude up to ~180: normalize into [0.0, 1.0]
                (grad_sum / (grad_count as f32 * 50.0)).clamp(0.0, 1.0)
            } else {
                0.0
            };

            let tray_id = if is_border { 0 } else { get_spatial_seed_tray_grid(r, c, rows, cols) };

            slots.push(PosterSlotFeature {
                r,
                c,
                is_border,
                is_corner,
                lab,
                gradient,
                color_std,
                tray_id,
            });
        }
    }

    slots
}

/// TRY-04: Initialize K=8 centroids from the 2x4 spatial grid
pub fn initialize_seeded_centroids(interior_slots: &[PosterSlotFeature]) -> Vec<Centroid> {
    let max_r = interior_slots.iter().map(|s| s.r).max().unwrap_or(0);
    let max_c = interior_slots.iter().map(|s| s.c).max().unwrap_or(0);
    let rows = (max_r + 2).max(POSTER_TOTAL_ROWS);
    let cols = (max_c + 2).max(POSTER_TOTAL_COLS);
    initialize_seeded_centroids_grid(interior_slots, rows, cols)
}

/// Initialize K=8 centroids from the 2x4 spatial grid for arbitrary puzzle grid dimensions
pub fn initialize_seeded_centroids_grid(
    interior_slots: &[PosterSlotFeature],
    rows: u32,
    cols: u32,
) -> Vec<Centroid> {
    let mut centroids = Vec::with_capacity(NUM_TRAYS);
    let r_denom = (rows.saturating_sub(3)).max(1) as f32;
    let c_denom = (cols.saturating_sub(3)).max(1) as f32;

    for tray_idx in 1..=NUM_TRAYS as u8 {
        let mut sum_l = 0.0f32;
        let mut sum_a = 0.0f32;
        let mut sum_b = 0.0f32;
        let mut sum_grad = 0.0f32;
        let mut sum_std = 0.0f32;
        let mut sum_r = 0.0f32;
        let mut sum_c = 0.0f32;
        let mut count = 0u32;

        for s in interior_slots {
            if get_spatial_seed_tray_grid(s.r, s.c, rows, cols) == tray_idx {
                sum_l += s.lab[0];
                sum_a += s.lab[1];
                sum_b += s.lab[2];
                sum_grad += s.gradient;
                sum_std += s.color_std;
                let r_norm = (s.r.saturating_sub(1)) as f32 / r_denom;
                let c_norm = (s.c.saturating_sub(1)) as f32 / c_denom;
                sum_r += r_norm;
                sum_c += c_norm;
                count += 1;
            }
        }

        if count > 0 {
            centroids.push(Centroid {
                lab: [sum_l / count as f32, sum_a / count as f32, sum_b / count as f32],
                gradient: sum_grad / count as f32,
                color_std: sum_std / count as f32,
                r_norm: sum_r / count as f32,
                c_norm: sum_c / count as f32,
            });
        } else {
            centroids.push(Centroid {
                lab: [50.0, 0.0, 0.0],
                gradient: 0.0,
                color_std: 0.0,
                r_norm: 0.5,
                c_norm: 0.5,
            });
        }
    }

    centroids
}

/// Compute weighted Euclidean distance between a slot feature and a centroid:
/// D^2 = w_c * norm_color_sq + w_t * d_texture_sq + w_s * d_spatial_sq
/// Robust physical calibration:
/// - Luminance (dL) is dynamically scaled (luminance_scale):
///   * High-chroma colorful artworks use ~0.40 damping to protect against camera glare
///   * Achromatic/metallic/monochrome scenes (e.g. cars/drawings) restore full 1.0 sensitivity
/// - Texture includes both Sobel gradient energy and rotation-invariant color_std (variance)
/// - Spatial distance uses normalized [0..1] coordinates
pub fn compute_slot_cluster_distance_sq(
    slot: &PosterSlotFeature,
    centroid: &Centroid,
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    luminance_scale: f32,
) -> f32 {
    compute_slot_cluster_distance_sq_grid(
        slot,
        centroid,
        w_color,
        w_texture,
        w_spatial,
        luminance_scale,
        25.0,
        33.0,
    )
}

/// Compute weighted Euclidean distance between a slot feature and a centroid for arbitrary grid dimensions
pub fn compute_slot_cluster_distance_sq_grid(
    slot: &PosterSlotFeature,
    centroid: &Centroid,
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    luminance_scale: f32,
    r_denom: f32,
    c_denom: f32,
) -> f32 {
    let dl = (slot.lab[0] - centroid.lab[0]) * luminance_scale;
    let da = slot.lab[1] - centroid.lab[1];
    let db = slot.lab[2] - centroid.lab[2];
    let de_cielab_sq = dl * dl + da * da + db * db;
    let norm_color_sq = de_cielab_sq / 900.0;

    // Rotation-invariant texture & entropy distance
    let d_grad = slot.gradient - centroid.gradient;
    let d_std = slot.color_std - centroid.color_std;
    let d_texture_sq = 0.55 * (d_grad * d_grad) + 0.45 * (d_std * d_std);

    // Spatial coordinates normalized across interior grid span
    let r_norm = (slot.r.saturating_sub(1)) as f32 / r_denom;
    let c_norm = (slot.c.saturating_sub(1)) as f32 / c_denom;
    let dr = r_norm - centroid.r_norm;
    let dc = c_norm - centroid.c_norm;
    // Calibrated spatial scaling:
    // Uses 3.5 multiplier so that spatial coherence acts as an organic elastic force
    // rather than an artificial rigid grid clamp, allowing tray boundaries to fluidly
    // follow visual landmarks (car contours, mountain ridges, horizons).
    let d_spatial_sq = (dr * dr + dc * dc) * 3.5;

    w_color * norm_color_sq + w_texture * d_texture_sq + w_spatial * d_spatial_sq
}

/// TRY-02 & TRY-03: Capacity-constrained weighted K-Means clustering (default 28 rows, 36 cols)
pub fn cluster_interior_slots(
    interior_slots: &[PosterSlotFeature],
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    max_capacity: u32,
    max_iterations: u32,
) -> (Vec<u8>, Vec<Centroid>, u32, f32) {
    let max_r = interior_slots.iter().map(|s| s.r).max().unwrap_or(0);
    let max_c = interior_slots.iter().map(|s| s.c).max().unwrap_or(0);
    let rows = (max_r + 2).max(POSTER_TOTAL_ROWS);
    let cols = (max_c + 2).max(POSTER_TOTAL_COLS);
    cluster_interior_slots_grid(
        interior_slots,
        w_color,
        w_texture,
        w_spatial,
        max_capacity,
        max_iterations,
        rows,
        cols,
    )
}

/// Capacity-constrained weighted K-Means clustering for arbitrary grid dimensions
pub fn cluster_interior_slots_grid(
    interior_slots: &[PosterSlotFeature],
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    max_capacity: u32,
    max_iterations: u32,
    rows: u32,
    cols: u32,
) -> (Vec<u8>, Vec<Centroid>, u32, f32) {
    let n = interior_slots.len();
    if n == 0 {
        return (Vec::new(), Vec::new(), 0, 0.0);
    }

    let r_denom = (rows.saturating_sub(3)).max(1) as f32;
    let c_denom = (cols.saturating_sub(3)).max(1) as f32;

    // 1. Normalize weights so user sliders operate consistently and don't skew penalty
    let sum_w = w_color + w_texture + w_spatial;
    let (nw_c, nw_t, nw_s) = if sum_w > 1e-4 {
        (w_color / sum_w, w_texture / sum_w, w_spatial / sum_w)
    } else {
        (0.34, 0.33, 0.33)
    };

    // 2. Measure overall image chroma saturation:
    // When an image is richly saturated (mean chroma > 12), damp luminance to 0.45 for physical glare invariance.
    // When an image is largely achromatic/metallic/grayscale (mean chroma < 7), scale luminance up to 0.95
    // so brightness boundaries (white studio sky vs silver car body vs black tires) create strong natural clusters.
    let mean_chroma: f32 = interior_slots
        .iter()
        .map(|s| (s.lab[1] * s.lab[1] + s.lab[2] * s.lab[2]).sqrt())
        .sum::<f32>()
        / n as f32;
    let luminance_scale = if mean_chroma >= 14.0 {
        0.45
    } else if mean_chroma <= 5.0 {
        0.95
    } else {
        0.95 - ((mean_chroma - 5.0) / 9.0) * 0.50
    };

    // 3. Initialize seeded centroids and store spatial anchor anchors
    let initial_seeds = initialize_seeded_centroids_grid(interior_slots, rows, cols);
    let seed_anchors: Vec<(f32, f32)> = initial_seeds
        .iter()
        .map(|c| (c.r_norm, c.c_norm))
        .collect();

    let mut centroids = initial_seeds;
    let mut assignments: Vec<u8> = interior_slots
        .iter()
        .map(|s| get_spatial_seed_tray_grid(s.r, s.c, rows, cols))
        .collect();

    let mut tray_counts = [0u32; NUM_TRAYS + 1];
    for &t in &assignments {
        tray_counts[t as usize] += 1;
    }

    let target_avg = (n as f32 / NUM_TRAYS as f32).round() as u32;
    let mut total_iterations = 0;
    let mut final_inertia = 0.0f32;

    for _iter in 0..max_iterations {
        total_iterations += 1;
        let mut reassignments = 0;
        final_inertia = 0.0;

        for i in 0..n {
            let slot = &interior_slots[i];
            let current_tray = assignments[i];

            let mut best_dist_penalized = f32::INFINITY;
            let mut best_tray = current_tray;
            let mut best_raw_dist_sq = 0.0f32;

            for t in 1..=NUM_TRAYS as u8 {
                let dist_sq = compute_slot_cluster_distance_sq_grid(
                    slot,
                    &centroids[(t - 1) as usize],
                    nw_c,
                    nw_t,
                    nw_s,
                    luminance_scale,
                    r_denom,
                    c_denom,
                );

                let current_count = tray_counts[t as usize];
                let count_for_eval = if t == current_tray {
                    current_count.saturating_sub(1)
                } else {
                    current_count
                };

                // Gentle capacity penalty above average, rigid wall at max capacity
                let mut capacity_penalty = 0.0f32;
                if count_for_eval >= target_avg {
                    let excess = (count_for_eval - target_avg) as f32;
                    capacity_penalty += excess * 0.015;
                }
                if count_for_eval >= max_capacity {
                    capacity_penalty += 10.0;
                }

                let penalized_dist = dist_sq.sqrt() + capacity_penalty;
                if penalized_dist < best_dist_penalized {
                    best_dist_penalized = penalized_dist;
                    best_tray = t;
                    best_raw_dist_sq = dist_sq;
                }
            }

            final_inertia += best_raw_dist_sq;

            if best_tray != current_tray {
                tray_counts[current_tray as usize] -= 1;
                tray_counts[best_tray as usize] += 1;
                assignments[i] = best_tray;
                reassignments += 1;
            }
        }

        // Recompute centroids with gentle spatial anchor bias (10%) to allow centroids
        // to naturally center on landmarks while preventing regional drift
        let mut sum_l = [0.0f32; NUM_TRAYS + 1];
        let mut sum_a = [0.0f32; NUM_TRAYS + 1];
        let mut sum_b = [0.0f32; NUM_TRAYS + 1];
        let mut sum_grad = [0.0f32; NUM_TRAYS + 1];
        let mut sum_std = [0.0f32; NUM_TRAYS + 1];
        let mut sum_r = [0.0f32; NUM_TRAYS + 1];
        let mut sum_c = [0.0f32; NUM_TRAYS + 1];
        let mut counts = [0u32; NUM_TRAYS + 1];

        for i in 0..n {
            let t = assignments[i] as usize;
            let s = &interior_slots[i];
            sum_l[t] += s.lab[0];
            sum_a[t] += s.lab[1];
            sum_b[t] += s.lab[2];
            sum_grad[t] += s.gradient;
            sum_std[t] += s.color_std;
            let r_norm = (s.r.saturating_sub(1)) as f32 / r_denom;
            let c_norm = (s.c.saturating_sub(1)) as f32 / c_denom;
            sum_r[t] += r_norm;
            sum_c[t] += c_norm;
            counts[t] += 1;
        }

        for t in 1..=NUM_TRAYS {
            if counts[t] > 0 {
                let mean_r = sum_r[t] / counts[t] as f32;
                let mean_c = sum_c[t] / counts[t] as f32;
                let (anchor_r, anchor_c) = seed_anchors[t - 1];

                // 90% cluster mean position + 10% gentle anchor guide
                let blended_r = 0.90 * mean_r + 0.10 * anchor_r;
                let blended_c = 0.90 * mean_c + 0.10 * anchor_c;

                centroids[t - 1] = Centroid {
                    lab: [
                        sum_l[t] / counts[t] as f32,
                        sum_a[t] / counts[t] as f32,
                        sum_b[t] / counts[t] as f32,
                    ],
                    gradient: sum_grad[t] / counts[t] as f32,
                    color_std: sum_std[t] / counts[t] as f32,
                    r_norm: blended_r,
                    c_norm: blended_c,
                };
            }
        }

        if reassignments < 3 {
            break;
        }
    }

    // Build slot spatial lookup table (row, col) -> index for 4-neighbor adjacency checking
    let mut grid_idx = vec![None; (rows * cols) as usize];
    for (idx, s) in interior_slots.iter().enumerate() {
        let g = (s.r * cols + s.c) as usize;
        if g < grid_idx.len() {
            grid_idx[g] = Some(idx);
        }
    }

    let get_nb = |r_idx: usize, c_idx: usize| -> Option<usize> {
        if r_idx < rows as usize && c_idx < cols as usize {
            grid_idx[r_idx * cols as usize + c_idx]
        } else {
            None
        }
    };

    // Pass 1: Neighbor Majority Smoothing (Iterated Conditional Modes)
    // Smooths out single-slot jitter along boundaries if a slot is surrounded by a different tray
    for _smooth_pass in 0..2 {
        for i in 0..n {
            let slot = &interior_slots[i];
            let current_tray = assignments[i];
            let r = slot.r as usize;
            let c = slot.c as usize;

            let neighbors = [
                if r > 0 { get_nb(r - 1, c) } else { None },
                get_nb(r + 1, c),
                if c > 0 { get_nb(r, c - 1) } else { None },
                get_nb(r, c + 1),
            ];

            let mut neighbor_tray_counts = [0u8; NUM_TRAYS + 1];
            let mut valid_neighbors = 0;
            for &nb in &neighbors {
                if let Some(idx) = nb {
                    neighbor_tray_counts[assignments[idx] as usize] += 1;
                    valid_neighbors += 1;
                }
            }

            // If 3 or more of 4 neighbors belong to another tray and that tray has room, adopt it
            if valid_neighbors >= 3 {
                for t in 1..=NUM_TRAYS {
                    if (t as u8) != current_tray && neighbor_tray_counts[t] >= 3 && tray_counts[t] < max_capacity {
                        tray_counts[current_tray as usize] -= 1;
                        tray_counts[t] += 1;
                        assignments[i] = t as u8;
                        break;
                    }
                }
            }
        }
    }

    // Pass 2: Connected Components Flood-Fill (Orphan Component Absorption)
    // Discovers any disconnected islands of each tray. Small islands (< 8 slots) are absorbed
    // into the bordering neighbor tray with the lowest feature cost.
    for _cc_pass in 0..3 {
        let mut visited = vec![false; n];
        let mut reassignments_cc = 0;

        for i in 0..n {
            if visited[i] {
                continue;
            }

            let tray = assignments[i];
            let mut component = Vec::new();
            let mut queue = std::collections::VecDeque::new();

            visited[i] = true;
            queue.push_back(i);

            while let Some(curr) = queue.pop_front() {
                component.push(curr);
                let cr = interior_slots[curr].r as usize;
                let cc = interior_slots[curr].c as usize;

                let neighbors = [
                    if cr > 0 { get_nb(cr - 1, cc) } else { None },
                    get_nb(cr + 1, cc),
                    if cc > 0 { get_nb(cr, cc - 1) } else { None },
                    get_nb(cr, cc + 1),
                ];

                for &nb in &neighbors {
                    if let Some(n_idx) = nb
                        && !visited[n_idx] && assignments[n_idx] == tray {
                            visited[n_idx] = true;
                            queue.push_back(n_idx);
                        }
                }
            }

            // If this island is small (< 8 slots) and not the entire tray, it's an orphan!
            if component.len() < 8 && component.len() < tray_counts[tray as usize] as usize {
                // Find all border trays touching this orphan component
                let mut touching_trays = [0u32; NUM_TRAYS + 1];
                for &idx in &component {
                    let cr = interior_slots[idx].r as usize;
                    let cc = interior_slots[idx].c as usize;
                    let neighbors = [
                        if cr > 0 { get_nb(cr - 1, cc) } else { None },
                        get_nb(cr + 1, cc),
                        if cc > 0 { get_nb(cr, cc - 1) } else { None },
                        get_nb(cr, cc + 1),
                    ];
                    for &nb in &neighbors {
                        if let Some(n_idx) = nb {
                            let nb_tray = assignments[n_idx];
                            if nb_tray != tray {
                                touching_trays[nb_tray as usize] += 1;
                            }
                        }
                    }
                }

                // Pick the candidate touching tray with lowest distance and available capacity
                let mut best_target_tray = 0u8;
                let mut best_target_cost = f32::INFINITY;

                for t in 1..=NUM_TRAYS {
                    if touching_trays[t] > 0 && tray_counts[t] + (component.len() as u32) <= max_capacity {
                        let mut sum_cost = 0.0f32;
                        for &idx in &component {
                            sum_cost += compute_slot_cluster_distance_sq_grid(
                                &interior_slots[idx],
                                &centroids[t - 1],
                                nw_c,
                                nw_t,
                                nw_s,
                                luminance_scale,
                                r_denom,
                                c_denom,
                            );
                        }
                        if sum_cost < best_target_cost {
                            best_target_cost = sum_cost;
                            best_target_tray = t as u8;
                        }
                    }
                }

                if best_target_tray > 0 {
                    let comp_len = component.len() as u32;
                    tray_counts[tray as usize] -= comp_len;
                    tray_counts[best_target_tray as usize] += comp_len;
                    for &idx in &component {
                        assignments[idx] = best_target_tray;
                    }
                    reassignments_cc += 1;
                }
            }
        }

        if reassignments_cc == 0 {
            break;
        }
    }

    // TRY-03: Hard post-process capacity overflow resolution with spatial adjacency preference
    loop {
        let mut overflow_tray = 0usize;
        for (t, &count) in tray_counts.iter().enumerate().skip(1).take(NUM_TRAYS) {
            if count > max_capacity {
                overflow_tray = t;
                break;
            }
        }
        if overflow_tray == 0 {
            break;
        }

        // Find candidate item in overflow tray:
        // Prioritize pieces on the boundary that actually border the candidate target tray!
        let mut best_item_idx = None;
        let mut best_target_tray = 0u8;
        let mut min_transfer_cost = f32::INFINITY;

        for i in 0..n {
            if assignments[i] as usize == overflow_tray {
                let slot = &interior_slots[i];
                let current_dist_sq = compute_slot_cluster_distance_sq_grid(
                    slot,
                    &centroids[overflow_tray - 1],
                    nw_c,
                    nw_t,
                    nw_s,
                    luminance_scale,
                    r_denom,
                    c_denom,
                );

                let r = slot.r as usize;
                let c = slot.c as usize;
                let neighbors = [
                    if r > 0 { get_nb(r - 1, c) } else { None },
                    get_nb(r + 1, c),
                    if c > 0 { get_nb(r, c - 1) } else { None },
                    get_nb(r, c + 1),
                ];

                for target_t in 1..=NUM_TRAYS {
                    if target_t != overflow_tray && tray_counts[target_t] < max_capacity {
                        let target_dist_sq = compute_slot_cluster_distance_sq_grid(
                            slot,
                            &centroids[target_t - 1],
                            nw_c,
                            nw_t,
                            nw_s,
                            luminance_scale,
                            r_denom,
                            c_denom,
                        );

                        let touches_target = neighbors.iter().any(|&nb| {
                            nb.map(|idx| assignments[idx] as usize == target_t).unwrap_or(false)
                        });

                        // Strictly require boundary pieces bordering the target tray
                        let adjacency_penalty = if touches_target { 0.0 } else { 2.0 };
                        let cost = (target_dist_sq - current_dist_sq) + adjacency_penalty;

                        if cost < min_transfer_cost {
                            min_transfer_cost = cost;
                            best_item_idx = Some(i);
                            best_target_tray = target_t as u8;
                        }
                    }
                }
            }
        }

        if let Some(idx) = best_item_idx {
            tray_counts[overflow_tray] -= 1;
            tray_counts[best_target_tray as usize] += 1;
            assignments[idx] = best_target_tray;
        } else {
            break; // No available transfer targets
        }
    }

    (assignments, centroids, total_iterations, final_inertia / n as f32)
}

/// Full analysis and clustering pipeline for default 36x28 puzzle grid
pub fn analyze_and_cluster_poster_internal(
    poster_rgba: &[u8],
    width: u32,
    height: u32,
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    max_capacity: u32,
) -> ClusteringResult {
    analyze_and_cluster_poster_grid_internal(
        poster_rgba,
        width,
        height,
        POSTER_TOTAL_COLS,
        POSTER_TOTAL_ROWS,
        w_color,
        w_texture,
        w_spatial,
        max_capacity,
    )
}

/// Full analysis and clustering pipeline for arbitrary puzzle grid dimensions
pub fn analyze_and_cluster_poster_grid_internal(
    poster_rgba: &[u8],
    width: u32,
    height: u32,
    cols: u32,
    rows: u32,
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    max_capacity: u32,
) -> ClusteringResult {
    let mut slots = extract_poster_features_grid(poster_rgba, width, height, cols, rows);
    let interior_slots: Vec<PosterSlotFeature> = slots.iter().filter(|s| !s.is_border).cloned().collect();

    let (assignments, _centroids, iterations, inertia) = cluster_interior_slots_grid(
        &interior_slots,
        w_color,
        w_texture,
        w_spatial,
        max_capacity,
        20,
        rows,
        cols,
    );

    let mut interior_idx = 0;
    for s in &mut slots {
        if s.is_border {
            s.tray_id = 0;
        } else {
            s.tray_id = assignments[interior_idx];
            interior_idx += 1;
        }
    }

    let mut tray_counts = [0u32; NUM_TRAYS + 1];
    for s in &slots {
        if !s.is_border {
            tray_counts[s.tray_id as usize] += 1;
        }
    }

    let mut default_trays = get_default_tray_definitions(max_capacity);
    let mut overflow_count = 0u32;
    for tray in &mut default_trays {
        let count = tray_counts[tray.id as usize];
        tray.count = count;
        if count > max_capacity {
            overflow_count += 1;
        }
    }

    let total_pieces = cols * rows;
    let border_pieces = if rows > 1 && cols > 1 {
        (cols * 2) + (rows - 2) * 2
    } else {
        total_pieces
    };
    let interior_pieces = total_pieces.saturating_sub(border_pieces);

    let stats = ClusteringStats {
        iterations,
        max_iterations: 20,
        inertia,
        is_balanced: overflow_count == 0,
        overflow_count,
        compute_time_ms: 0,
        total_pieces,
        border_pieces,
        interior_pieces,
    };

    ClusteringResult {
        slots,
        trays: default_trays,
        stats,
    }
}

/// TRY-05: WASM entrypoint (default 36x28 puzzle grid)
#[wasm_bindgen]
pub fn analyze_and_cluster_poster(
    poster_rgba: &[u8],
    width: u32,
    height: u32,
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    max_capacity: u32,
) -> Result<JsValue, JsValue> {
    analyze_and_cluster_poster_grid(
        poster_rgba,
        width,
        height,
        POSTER_TOTAL_COLS,
        POSTER_TOTAL_ROWS,
        w_color,
        w_texture,
        w_spatial,
        max_capacity,
    )
}

/// WASM entrypoint for arbitrary puzzle grid dimensions
#[wasm_bindgen]
pub fn analyze_and_cluster_poster_grid(
    poster_rgba: &[u8],
    width: u32,
    height: u32,
    cols: u32,
    rows: u32,
    w_color: f32,
    w_texture: f32,
    w_spatial: f32,
    max_capacity: u32,
) -> Result<JsValue, JsValue> {
    if poster_rgba.len() < (width * height * 4) as usize {
        return Err(JsValue::from_str("Invalid poster_rgba buffer length"));
    }

    let start_ms = web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0);

    let mut result = analyze_and_cluster_poster_grid_internal(
        poster_rgba,
        width,
        height,
        cols,
        rows,
        w_color,
        w_texture,
        w_spatial,
        max_capacity,
    );

    let end_ms = web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(start_ms);

    result.stats.compute_time_ms = (end_ms - start_ms).max(0.0).round() as u32;

    serde_wasm_bindgen::to_value(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}


