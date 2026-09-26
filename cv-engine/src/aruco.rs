use crate::homography::Point2D;

/// A detected calibration quad with ordered corners (Top-Left, Top-Right, Bottom-Right, Bottom-Left)
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct MatCorners {
    pub top_left: Point2D,
    pub top_right: Point2D,
    pub bottom_right: Point2D,
    pub bottom_left: Point2D,
}

impl MatCorners {
    pub fn as_array(&self) -> [Point2D; 4] {
        [self.top_left, self.top_right, self.bottom_right, self.bottom_left]
    }
}

/// Refines a seed point by snapping to the nearest high-contrast circular/bullseye fiducial centroid
/// within a localized search radius (e.g. 24 pixels). Uses intensity-inverted centroid weighting.
pub fn refine_fiducial_centroid(
    pixels: &[u8],
    width: u32,
    height: u32,
    seed_x: f32,
    seed_y: f32,
    radius: i32,
) -> Point2D {
    let cx = seed_x.round() as i32;
    let cy = seed_y.round() as i32;

    let x_min = (cx - radius).max(0);
    let x_max = (cx + radius).min(width as i32 - 1);
    let y_min = (cy - radius).max(0);
    let y_max = (cy + radius).min(height as i32 - 1);

    let mut weight_sum: f64 = 0.0;
    let mut weighted_x: f64 = 0.0;
    let mut weighted_y: f64 = 0.0;
    let rad_sq = (radius * radius) as f32;

    // Two-pass approach:
    // 1. Find min and max luminance in the circular search window
    let mut min_lum = 255u32;
    let mut max_lum = 0u32;

    for y in y_min..=y_max {
        for x in x_min..=x_max {
            let dx = (x - cx) as f32;
            let dy = (y - cy) as f32;
            if dx * dx + dy * dy <= rad_sq {
                let idx = ((y as u32 * width + x as u32) * 4) as usize;
                if idx + 2 < pixels.len() {
                    let r = pixels[idx] as u32;
                    let g = pixels[idx + 1] as u32;
                    let b = pixels[idx + 2] as u32;
                    let lum = (r * 299 + g * 587 + b * 114) / 1000;
                    if lum < min_lum { min_lum = lum; }
                    if lum > max_lum { max_lum = lum; }
                }
            }
        }
    }

    // If there is insufficient contrast across the window (< 25 levels), don't snap
    if max_lum.saturating_sub(min_lum) < 25 {
        return Point2D { x: seed_x, y: seed_y };
    }

    // 2. Compute centroid weighted by contrast relative to max luminance
    let contrast_range = (max_lum - min_lum) as f64;
    for y in y_min..=y_max {
        for x in x_min..=x_max {
            let dx = (x - cx) as f32;
            let dy = (y - cy) as f32;
            if dx * dx + dy * dy <= rad_sq {
                let idx = ((y as u32 * width + x as u32) * 4) as usize;
                if idx + 2 < pixels.len() {
                    let r = pixels[idx] as u32;
                    let g = pixels[idx + 1] as u32;
                    let b = pixels[idx + 2] as u32;
                    let lum = (r * 299 + g * 587 + b * 114) / 1000;
                    
                    // Normalized darkness score in [0, 1]
                    let darkness_norm = (max_lum.saturating_sub(lum)) as f64 / contrast_range;
                    // Cubic sharpening to isolate the central dark core precisely
                    let weight = darkness_norm * darkness_norm * darkness_norm;

                    weighted_x += x as f64 * weight;
                    weighted_y += y as f64 * weight;
                    weight_sum += weight;
                }
            }
        }
    }

    if weight_sum > 1e-4 {
        Point2D {
            x: (weighted_x / weight_sum) as f32,
            y: (weighted_y / weight_sum) as f32,
        }
    } else {
        Point2D { x: seed_x, y: seed_y }
    }
}

/// Automatically searches each frame quadrant for the 4 fiducials starting from initial quadrant seeds
pub fn auto_detect_mat_corners(
    pixels: &[u8],
    width: u32,
    height: u32,
    current_corners: &[Point2D; 4],
) -> [Point2D; 4] {
    let mut refined = [
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: 0.0, y: 0.0 },
        Point2D { x: 0.0, y: 0.0 },
    ];

    let w_f = width as f32;
    let h_f = height as f32;

    // Fallback default seeds in each quadrant if current points are invalid
    let default_seeds = [
        Point2D { x: w_f * 0.30, y: h_f * 0.20 }, // TL
        Point2D { x: w_f * 0.70, y: h_f * 0.20 }, // TR
        Point2D { x: w_f * 0.70, y: h_f * 0.80 }, // BR
        Point2D { x: w_f * 0.30, y: h_f * 0.80 }, // BL
    ];

    for i in 0..4 {
        let seed = if current_corners[i].x > 10.0 && current_corners[i].y > 10.0 {
            current_corners[i]
        } else {
            default_seeds[i]
        };

        // First snap with coarse radius (32px), then refine with precision radius (14px)
        let coarse = refine_fiducial_centroid(pixels, width, height, seed.x, seed.y, 32);
        let fine = refine_fiducial_centroid(pixels, width, height, coarse.x, coarse.y, 14);
        refined[i] = fine;
    }

    refined
}

/// Computes a normalized high-frequency focus/sharpness MTF score [0.0, 100.0]% using
/// Laplacian energy gradient variance on the optical stage
pub fn compute_focus_mtf(
    pixels: &[u8],
    width: u32,
    height: u32,
    corners: &[Point2D; 4],
) -> f32 {
    let w = width as i32;
    let h = height as i32;

    // Sample around center between corners
    let cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) * 0.25;
    let cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) * 0.25;

    let rad = 25i32;
    let x_min = (cx as i32 - rad).clamp(2, w - 3);
    let x_max = (cx as i32 + rad).clamp(2, w - 3);
    let y_min = (cy as i32 - rad).clamp(2, h - 3);
    let y_max = (cy as i32 + rad).clamp(2, h - 3);

    let mut sum_lap: f64 = 0.0;
    let mut sum_lap_sq: f64 = 0.0;
    let mut count: f64 = 0.0;

    for y in y_min..=y_max {
        for x in x_min..=x_max {
            let get_lum = |px: i32, py: i32| -> f64 {
                let idx = ((py * w + px) * 4) as usize;
                if idx + 2 < pixels.len() {
                    pixels[idx] as f64 * 0.299 + pixels[idx + 1] as f64 * 0.587 + pixels[idx + 2] as f64 * 0.114
                } else {
                    0.0
                }
            };

            // 3x3 Discrete Laplacian kernel
            let lap = -4.0 * get_lum(x, y)
                + get_lum(x - 1, y)
                + get_lum(x + 1, y)
                + get_lum(x, y - 1)
                + get_lum(x, y + 1);

            sum_lap += lap;
            sum_lap_sq += lap * lap;
            count += 1.0;
        }
    }

    if count > 0.0 {
        let mean = sum_lap / count;
        let variance = (sum_lap_sq / count - mean * mean).max(0.0);
        // Normalize variance: typical sharp image has var >= 400
        (variance as f32 / 5.0).clamp(0.0, 100.0)
    } else {
        0.0
    }
}
