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
        Point2D { x: w_f * 0.32, y: h_f * 0.22 }, // TL
        Point2D { x: w_f * 0.68, y: h_f * 0.22 }, // TR
        Point2D { x: w_f * 0.68, y: h_f * 0.78 }, // BR
        Point2D { x: w_f * 0.32, y: h_f * 0.78 }, // BL
    ];

    for i in 0..4 {
        let seed = if current_corners[i].x > 10.0 && current_corners[i].x < w_f - 10.0
            && current_corners[i].y > 10.0 && current_corners[i].y < h_f - 10.0 {
            current_corners[i]
        } else {
            default_seeds[i]
        };

        // Multi-stage snapping:
        // 1. Wide search (radius 48px) to locate marker square center
        // 2. Medium search (radius 24px) to center on marker
        // 3. Precision search (radius 12px) for sub-pixel accuracy
        let coarse = refine_fiducial_centroid(pixels, width, height, seed.x, seed.y, 48);
        let medium = refine_fiducial_centroid(pixels, width, height, coarse.x, coarse.y, 24);
        let fine = refine_fiducial_centroid(pixels, width, height, medium.x, medium.y, 12);
        refined[i] = fine;
    }

    refined
}

/// Automatically computes optimal lens radial distortion k1 [-0.35, +0.35]
/// using the straight-line plumbline method across the 4 perimeter rails of the mat.
/// In true physical space, the rails connecting the corners are straight.
/// Under lens distortion, straight lines bend into parabolic curves.
/// This function finds the k1 that minimizes the curved deviation of rail edges.
pub fn auto_calibrate_lens_k1(
    pixels: &[u8],
    width: u32,
    height: u32,
    corners: &[Point2D; 4],
) -> f32 {
    let w_f = width as f32;
    let h_f = height as f32;

    // Sample midpoints of the 4 outer sides between corners
    // In an undistorted plane with rectilinear projection, the edge midpoint is the average of corners.
    // In a distorted image, the physical straight edge arcs away from the chord midpoint.
    let mut best_k1 = 0.0f32;
    let mut min_edge_curvature_var = f32::MAX;

    // Candidate test range for typical webcams (-0.25 to +0.25, step 0.01)
    let mut test_k1 = -0.30f32;
    while test_k1 <= 0.30f32 {
        let mut total_deviation = 0.0f32;

        for side in 0..4 {
            let p_start = corners[side];
            let p_end = corners[(side + 1) % 4];

            // Undistort endpoints with candidate k1
            let un_start = crate::homography::undistort_point(p_start, w_f, h_f, test_k1);
            let un_end = crate::homography::undistort_point(p_end, w_f, h_f, test_k1);

            // True straight chord midpoint in undistorted space
            let un_mid = Point2D {
                x: (un_start.x + un_end.x) * 0.5,
                y: (un_start.y + un_end.y) * 0.5,
            };

            // Re-distort chord midpoint to find where candidate says it should be on sensor
            let expected_dist_mid = crate::homography::apply_radial_distortion(un_mid, w_f, h_f, test_k1);

            // Sample along normal around expected position to find highest gradient (contrast edge)
            // Direction along chord from p_start to p_end
            let dx = p_end.x - p_start.x;
            let dy = p_end.y - p_start.y;
            let len = (dx * dx + dy * dy).sqrt().max(1.0);
            // Inward-pointing normal perpendicular to chord
            let nx = -dy / len;
            let ny = dx / len;

            // Search +/- 16 pixels along normal for maximum contrast edge
            let mut max_grad = 0.0f32;
            let mut best_step = 0.0f32;

            for step in -16..=16 {
                let sample_x = (expected_dist_mid.x + nx * (step as f32)).round() as i32;
                let sample_y = (expected_dist_mid.y + ny * (step as f32)).round() as i32;

                if sample_x >= 2 && sample_x < (width as i32 - 2) && sample_y >= 2 && sample_y < (height as i32 - 2) {
                    let idx1 = (((sample_y + ny.round() as i32) * width as i32 + (sample_x + nx.round() as i32)) * 4) as usize;
                    let idx0 = (((sample_y - ny.round() as i32) * width as i32 + (sample_x - nx.round() as i32)) * 4) as usize;
                    if idx1 + 2 < pixels.len() && idx0 + 2 < pixels.len() {
                        let lum1 = pixels[idx1] as f32 * 0.299 + pixels[idx1 + 1] as f32 * 0.587 + pixels[idx1 + 2] as f32 * 0.114;
                        let lum0 = pixels[idx0] as f32 * 0.299 + pixels[idx0 + 1] as f32 * 0.587 + pixels[idx0 + 2] as f32 * 0.114;
                        let grad = (lum1 - lum0).abs();
                        if grad > max_grad {
                            max_grad = grad;
                            best_step = step as f32;
                        }
                    }
                }
            }

            if max_grad > 15.0 {
                total_deviation += best_step.abs();
            } else {
                total_deviation += 6.0;
            }
        }

        if total_deviation < min_edge_curvature_var {
            min_edge_curvature_var = total_deviation;
            best_k1 = test_k1;
        }

        test_k1 += 0.01;
    }

    best_k1.clamp(-0.40, 0.40)
}

/// Computes a normalized high-frequency focus/sharpness MTF score [0.0, 100.0]% using
/// Laplacian energy gradient variance on high-contrast fiducial/rail patches
pub fn compute_focus_mtf(
    pixels: &[u8],
    width: u32,
    height: u32,
    corners: &[Point2D; 4],
) -> f32 {
    let w = width as i32;
    let h = height as i32;

    // Sample high-contrast features: around the 4 corners (ArUco markers) and center
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

    for pt in &sample_points {
        let x_min = (pt.x as i32 - rad).clamp(2, w - 3);
        let x_max = (pt.x as i32 + rad).clamp(2, w - 3);
        let y_min = (pt.y as i32 - rad).clamp(2, h - 3);
        let y_max = (pt.y as i32 + rad).clamp(2, h - 3);

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
        // Sharp printed fiducials yield energy ~ 250..1200+
        (energy as f32 / 12.0).clamp(0.0, 100.0)
    } else {
        0.0
    }
}
