use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

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

/// Convert an RGBA buffer (4 bytes per pixel) into a single-channel grayscale buffer (1 byte per pixel).
/// Uses standard luminance weights: Y = 0.299*R + 0.587*G + 0.114*B.
pub fn rgba_to_grayscale(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let pixel_count = (width * height) as usize;
    let mut gray = vec![0u8; pixel_count];
    let src_len = rgba.len().min(pixel_count * 4);

    for i in 0..(src_len / 4) {
        let r = rgba[i * 4] as u32;
        let g = rgba[i * 4 + 1] as u32;
        let b = rgba[i * 4 + 2] as u32;
        let lum = (299 * r + 587 * g + 114 * b) / 1000;
        gray[i] = lum.min(255) as u8;
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

    let tile_w = (w + tx - 1) / tx;
    let tile_h = (h + ty - 1) / ty;

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
            for i in 0..256 {
                if hist[i] > clip_limit {
                    clipped_excess += hist[i] - clip_limit;
                    hist[i] = clip_limit;
                }
            }

            // Redistribute excess evenly across all bins
            let redistrib = clipped_excess / 256;
            let residual = clipped_excess % 256;
            for i in 0..256 {
                hist[i] += redistrib;
                if (i as u32) < residual {
                    hist[i] += 1;
                }
            }

            // Calculate Cumulative Distribution Function (CDF)
            let mut cdf = 0u32;
            let tile_idx = gy * tx + gx;
            for i in 0..256 {
                cdf += hist[i];
                let mapped = ((cdf as f32 / count as f32) * 255.0).round();
                tile_mappings[tile_idx][i] = mapped.min(255.0).max(0.0) as u8;
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

            dst[row_idx + x] = out.round().min(255.0).max(0.0) as u8;
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
            let sx1 = ((x * 2 + 1) as usize).min((src_h - 1) as usize);

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

            let is_left = c == 0;
            let is_right = c == cols - 1;
            let is_top = r == 0;
            let is_bottom = r == rows - 1;

            let is_corner = (is_left || is_right) && (is_top || is_bottom);
            let is_border = is_left || is_right || is_top || is_bottom;

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
    // 1. sRGB to linear RGB
    let to_linear = |val: u8| -> f32 {
        let v = (val as f32) / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    let lr = to_linear(r);
    let lg = to_linear(g);
    let lb = to_linear(b);

    // 2. Linear RGB to XYZ
    let x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
    let y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
    let z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;

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

    let mean_r = if count > 0 { (sum_r / count) as u8 } else { 0 };
    let mean_g = if count > 0 { (sum_g / count) as u8 } else { 0 };
    let mean_b = if count > 0 { (sum_b / count) as u8 } else { 0 };

    let lab = rgb_to_cielab(mean_r, mean_g, mean_b);

    let is_left = col == 0;
    let is_right = col == cols - 1;
    let is_top = row == 0;
    let is_bottom = row == rows - 1;

    let is_corner = (is_left || is_right) && (is_top || is_bottom);
    let is_border = is_left || is_right || is_top || is_bottom;

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
pub fn extract_visual_fingerprint(
    rgba: &[u8],
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

    // Subsample step for speed if piece crop is large
    let step = (pixel_count / 1000).max(1);
    let mut sampled_count = 0.0f32;

    for i in (0..pixel_count).step_by(step) {
        let alpha = rgba[i * 4 + 3];
        if alpha < 50 {
            continue; // Skip transparent / background
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
        let m = mag[i] as f32;
        if m > 15.0 {
            let bin = (ori[i] as usize).min(7);
            ori_hist[bin] += m;
            total_grad += m;
        }
    }

    if total_grad > 0.0 {
        for b in 0..8 {
            ori_hist[b] /= total_grad;
        }
    } else {
        for b in 0..8 {
            ori_hist[b] = 0.125;
        }
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

/// WASM entry point: Real-time candidate poster localization.
/// Scans the piece against all slots across 4 cardinal rotations (0°, 90°, 180°, 270°)
/// and returns the best matching slots with confidence scores.
#[wasm_bindgen]
pub fn locate_piece_on_poster(
    piece_rgba: &[u8],
    piece_w: u32,
    piece_h: u32,
    poster_rgba: &[u8],
    poster_w: u32,
    poster_h: u32,
    cols: u32,
    rows: u32,
    is_border_hint: bool,
    is_corner_hint: bool,
) -> Result<JsValue, JsValue> {
    if cols == 0 || rows == 0 || poster_w == 0 || poster_h == 0 || piece_w == 0 || piece_h == 0 {
        return Err(JsValue::from_str("Invalid dimensions for poster localization"));
    }

    // Extract piece fingerprint
    let (piece_lab, piece_hist) = extract_visual_fingerprint(piece_rgba, piece_w, piece_h);

    let cell_w = (poster_w as f32 / cols as f32).round() as usize;
    let cell_h = (poster_h as f32 / rows as f32).round() as usize;

    let mut scored_slots: Vec<CandidatePosterSlot> = Vec::new();

    // Rotations: 0 = 0°, 1 = 90°, 2 = 180°, 3 = 270°
    let rotations_deg = [0.0f32, 90.0f32, 180.0f32, 270.0f32];

    for r in 0..rows {
        for c in 0..cols {
            let is_slot_corner = (r == 0 && c == 0) || (r == 0 && c == cols - 1)
                || (r == rows - 1 && c == 0) || (r == rows - 1 && c == cols - 1);
            let is_slot_border = r == 0 || r == rows - 1 || c == 0 || c == cols - 1;

            // Geometry filter: if piece is known corner/border, only check appropriate slots
            if is_corner_hint && !is_slot_corner {
                continue;
            }
            if is_border_hint && !is_corner_hint && (!is_slot_border || is_slot_corner) {
                continue;
            }
            if !is_border_hint && is_slot_border {
                // If piece is pure interior, penalize or skip borders
                continue;
            }

            // Extract slot crop sample (downsampled central region for speed)
            let x0 = (c as f32 * (poster_w as f32 / cols as f32)) as usize;
            let y0 = (r as f32 * (poster_h as f32 / rows as f32)) as usize;
            let sub_w = cell_w.min(poster_w as usize - x0);
            let sub_h = cell_h.min(poster_h as usize - y0);

            if sub_w < 4 || sub_h < 4 {
                continue;
            }

            let mut slot_rgba = vec![0u8; sub_w * sub_h * 4];
            for sy in 0..sub_h {
                let src_idx = ((y0 + sy) * (poster_w as usize) + x0) * 4;
                let dst_idx = (sy * sub_w) * 4;
                let len = sub_w * 4;
                if src_idx + len <= poster_rgba.len() {
                    slot_rgba[dst_idx..dst_idx + len].copy_from_slice(&poster_rgba[src_idx..src_idx + len]);
                }
            }

            let (slot_lab, slot_hist) = extract_visual_fingerprint(&slot_rgba, sub_w as u32, sub_h as u32);

            // Test across 4 rotations
            let mut best_rot = 0.0f32;
            let mut max_sim = 0.0f32;

            for (k, &rot_deg) in rotations_deg.iter().enumerate() {
                let rot_hist = rotate_gradient_histogram(&piece_hist, k);
                let sim = compute_slot_similarity(&piece_lab, &rot_hist, &slot_lab, &slot_hist);
                if sim > max_sim {
                    max_sim = sim;
                    best_rot = rot_deg;
                }
            }

            scored_slots.push(CandidatePosterSlot {
                col: c,
                row: r,
                rotation_deg: best_rot,
                confidence: max_sim,
            });
        }
    }

    // Sort descending by confidence
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
