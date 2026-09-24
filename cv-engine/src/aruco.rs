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

    // The fiducial center is a dark concentric circle.
    // Darkness inverted (255 - luminance) gives higher weight to the bullseye center.
    let rad_sq = (radius * radius) as f32;

    for y in y_min..=y_max {
        for x in x_min..=x_max {
            let dx = (x - cx) as f32;
            let dy = (y - cy) as f32;
            let dist_sq = dx * dx + dy * dy;

            if dist_sq <= rad_sq {
                let idx = ((y as u32 * width + x as u32) * 4) as usize;
                if idx + 2 < pixels.len() {
                    let r = pixels[idx] as u32;
                    let g = pixels[idx + 1] as u32;
                    let b = pixels[idx + 2] as u32;
                    let lum = (r * 299 + g * 587 + b * 114) / 1000;
                    
                    // Emphasize deep blacks (dark center spot)
                    let darkness = (255 - lum) as f64;
                    let weight = darkness * darkness; // quadratic contrast boost

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
