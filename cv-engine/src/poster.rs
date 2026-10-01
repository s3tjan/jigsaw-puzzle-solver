use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Representation of a single pyramid level (downscaled grayscale image).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PyramidLevel {
    pub level: usize,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub pixels: Vec<u8>,
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
        // Integer fixed-point math: (299*R + 587*G + 114*B) / 1000
        let lum = (299 * r + 587 * g + 114 * b) / 1000;
        gray[i] = lum.min(255) as u8;
    }
    gray
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

/// Generates a multi-scale pyramid from an initial grayscale image up to max_levels or until dimension < 32px.
pub fn build_grayscale_pyramid(gray_base: &[u8], width: u32, height: u32, max_levels: usize) -> Vec<PyramidLevel> {
    let mut levels = Vec::new();

    // Level 0: Original resolution
    levels.push(PyramidLevel {
        level: 0,
        width,
        height,
        scale: 1.0,
        pixels: gray_base.to_vec(),
    });

    let mut current_pixels = gray_base.to_vec();
    let mut curr_w = width;
    let mut curr_h = height;
    let mut curr_scale = 1.0f32;

    for lvl in 1..max_levels {
        if curr_w <= 16 || curr_h <= 16 {
            break;
        }
        let (downscaled, next_w, next_h) = downsample_2x(&current_pixels, curr_w, curr_h);
        curr_scale *= 0.5;
        levels.push(PyramidLevel {
            level: lvl,
            width: next_w,
            height: next_h,
            scale: curr_scale,
            pixels: downscaled.clone(),
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

