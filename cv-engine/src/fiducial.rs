use crate::homography::Point2D;

/// Refines a seed point by snapping to the nearest high-contrast circular/bullseye fiducial centroid
/// within a localized search radius (e.g. 24-32 pixels). Uses intensity-inverted centroid weighting.
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
                    let lum = crate::poster::rgb_to_luminance(pixels[idx], pixels[idx + 1], pixels[idx + 2]) as u32;
                    if lum < min_lum { min_lum = lum; }
                    if lum > max_lum { max_lum = lum; }
                }
            }
        }
    }

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
                    let lum = crate::poster::rgb_to_luminance(pixels[idx], pixels[idx + 1], pixels[idx + 2]) as u32;

                    let darkness_norm = (max_lum.saturating_sub(lum)) as f64 / contrast_range;
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

/// Computes a normalized high-frequency focus/sharpness MTF score [0.0, 100.0]% using
/// Laplacian energy gradient variance on high-contrast fiducial patches
pub fn compute_focus_mtf(
    pixels: &[u8],
    width: u32,
    height: u32,
    corners: &[Point2D; 4],
) -> f32 {
    if width < 6 || height < 6 {
        return 0.0;
    }

    let w = width as i32;
    let h = height as i32;

    let mut sum_lap_sq: f64 = 0.0;
    let mut count: f64 = 0.0;

    let sample_points = [
        corners[0],
        corners[1],
        corners[2],
        corners[3],
        Point2D {
            x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) * 0.25,
            y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) * 0.25,
        },
    ];

    let rad = 14i32;

    let get_lum = |px: i32, py: i32| -> f64 {
        let idx = ((py * w + px) * 4) as usize;
        if idx + 2 < pixels.len() {
            crate::poster::rgb_to_luminance(pixels[idx], pixels[idx + 1], pixels[idx + 2]) as f64
        } else {
            0.0
        }
    };

    for pt in &sample_points {
        let x_min = (pt.x as i32 - rad).clamp(2, w - 3);
        let x_max = (pt.x as i32 + rad).clamp(2, w - 3);
        let y_min = (pt.y as i32 - rad).clamp(2, h - 3);
        let y_max = (pt.y as i32 + rad).clamp(2, h - 3);

        for y in y_min..=y_max {
            for x in x_min..=x_max {
                let lap = -4.0 * get_lum(x, y)
                    + get_lum(x - 1, y)
                    + get_lum(x + 1, y)
                    + get_lum(x, y - 1)
                    + get_lum(x, y + 1);

                sum_lap_sq += lap * lap;
                count += 1.0;
            }
        }
    }

    if count > 0.0 {
        let energy = sum_lap_sq / count;
        (energy as f32 / 12.0).clamp(0.0, 100.0)
    } else {
        0.0
    }
}
