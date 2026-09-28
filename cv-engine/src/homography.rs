/// Represents a 2D floating point coordinate
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Point2D {
    pub x: f32,
    pub y: f32,
}

/// 3x3 Homography Matrix for projective transformation
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct Homography {
    pub h: [f64; 9],
}

impl Homography {
    /// Compute a 3x3 homography matrix mapping 4 source points to 4 destination points
    /// using Direct Linear Transform (DLT) with Gaussian elimination / SVD approximation
    pub fn from_4_points(src: &[Point2D; 4], dst: &[Point2D; 4]) -> Option<Self> {
        // Construct 8x8 linear system A * h = b
        // where h = [h00, h01, h02, h10, h11, h12, h20, h21]^T and h22 is normalized to 1.0
        let mut a = [[0.0f64; 8]; 8];
        let mut b = [0.0f64; 8];

        for i in 0..4 {
            let sx = src[i].x as f64;
            let sy = src[i].y as f64;
            let dx = dst[i].x as f64;
            let dy = dst[i].y as f64;

            // Row 2*i: sx*h00 + sy*h01 + h02 - sx*dx*h20 - sy*dx*h21 = dx
            a[2 * i][0] = sx;
            a[2 * i][1] = sy;
            a[2 * i][2] = 1.0;
            a[2 * i][3] = 0.0;
            a[2 * i][4] = 0.0;
            a[2 * i][5] = 0.0;
            a[2 * i][6] = -sx * dx;
            a[2 * i][7] = -sy * dx;
            b[2 * i] = dx;

            // Row 2*i+1: sx*h10 + sy*h11 + h12 - sx*dy*h20 - sy*dy*h21 = dy
            a[2 * i + 1][0] = 0.0;
            a[2 * i + 1][1] = 0.0;
            a[2 * i + 1][2] = 0.0;
            a[2 * i + 1][3] = sx;
            a[2 * i + 1][4] = sy;
            a[2 * i + 1][5] = 1.0;
            a[2 * i + 1][6] = -sx * dy;
            a[2 * i + 1][7] = -sy * dy;
            b[2 * i + 1] = dy;
        }

        // Gaussian elimination with partial pivoting to solve A * h = b
        let n = 8;
        for col in 0..n {
            // Find pivot
            let mut max_row = col;
            let mut max_val = a[col][col].abs();
            for r in (col + 1)..n {
                if a[r][col].abs() > max_val {
                    max_val = a[r][col].abs();
                    max_row = r;
                }
            }

            if max_val < 1e-9 {
                return None; // Singular matrix (collinear points)
            }

            // Swap rows
            if max_row != col {
                a.swap(col, max_row);
                b.swap(col, max_row);
            }

            // Pivot normalization
            let pivot = a[col][col];
            for c in col..n {
                a[col][c] /= pivot;
            }
            b[col] /= pivot;

            // Eliminate column from other rows
            for r in 0..n {
                if r != col {
                    let factor = a[r][col];
                    if factor.abs() > 1e-12 {
                        for c in col..n {
                            a[r][c] -= factor * a[col][c];
                        }
                        b[r] -= factor * b[col];
                    }
                }
            }
        }

        Some(Homography {
            h: [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1.0],
        })
    }

    /// Invert 3x3 homography matrix (for unwarping target back to source coordinate space)
    pub fn invert(&self) -> Option<Self> {
        let m = self.h;
        // Determinant of 3x3
        let det = m[0] * (m[4] * m[8] - m[5] * m[7])
            - m[1] * (m[3] * m[8] - m[5] * m[6])
            + m[2] * (m[3] * m[7] - m[4] * m[6]);

        if det.abs() < 1e-12 {
            return None;
        }

        let invdet = 1.0 / det;

        let inv = [
            (m[4] * m[8] - m[5] * m[7]) * invdet,
            (m[2] * m[7] - m[1] * m[8]) * invdet,
            (m[1] * m[5] - m[2] * m[4]) * invdet,
            (m[5] * m[6] - m[3] * m[8]) * invdet,
            (m[0] * m[8] - m[2] * m[6]) * invdet,
            (m[2] * m[3] - m[0] * m[5]) * invdet,
            (m[3] * m[7] - m[4] * m[6]) * invdet,
            (m[1] * m[6] - m[0] * m[7]) * invdet,
            (m[0] * m[4] - m[1] * m[3]) * invdet,
        ];

        Some(Homography { h: inv })
    }

    /// Map a point through the homography: [x', y', w']^T = H * [x, y, 1]^T
    pub fn transform_point(&self, p: Point2D) -> Point2D {
        let x = p.x as f64;
        let y = p.y as f64;
        let m = self.h;

        let w = m[6] * x + m[7] * y + m[8];
        if w.abs() < 1e-9 {
            return Point2D { x: 0.0, y: 0.0 };
        }
        let inv_w = 1.0 / w;
        let px = (m[0] * x + m[1] * y + m[2]) * inv_w;
        let py = (m[3] * x + m[4] * y + m[5]) * inv_w;

        Point2D {
            x: px as f32,
            y: py as f32,
        }
    }
}

/// Apply radial lens distortion to a 2D point given image dimensions and k1 coefficient
pub fn apply_radial_distortion(pt: Point2D, w: f32, h: f32, k1: f32) -> Point2D {
    if k1.abs() <= 1e-4 {
        return pt;
    }
    let cx = w * 0.5;
    let cy = h * 0.5;
    let diag = (cx * cx + cy * cy).sqrt().max(1.0);
    let norm_x = (pt.x - cx) / diag;
    let norm_y = (pt.y - cy) / diag;
    let r2 = norm_x * norm_x + norm_y * norm_y;
    let factor = 1.0 + k1 * r2;
    Point2D {
        x: cx + norm_x * factor * diag,
        y: cy + norm_y * factor * diag,
    }
}

/// Invert radial lens distortion for a point (from distorted sensor coordinate to rectilinear undistorted plane)
pub fn undistort_point(pt: Point2D, w: f32, h: f32, k1: f32) -> Point2D {
    if k1.abs() <= 1e-4 {
        return pt;
    }
    let cx = w * 0.5;
    let cy = h * 0.5;
    let diag = (cx * cx + cy * cy).sqrt().max(1.0);
    let dist_x = (pt.x - cx) / diag;
    let dist_y = (pt.y - cy) / diag;
    let r_dist = (dist_x * dist_x + dist_y * dist_y).sqrt();
    if r_dist < 1e-6 {
        return pt;
    }

    // Fixed-point Newton iterations to solve r_dist = r_un * (1 + k1 * r_un^2)
    let mut r_un = r_dist;
    for _ in 0..5 {
        let f = r_un * (1.0 + k1 * r_un * r_un) - r_dist;
        let df = 1.0 + 3.0 * k1 * r_un * r_un;
        if df.abs() > 1e-6 {
            r_un -= f / df;
        }
    }

    let scale = (r_un / r_dist).max(0.1).min(3.0);
    Point2D {
        x: cx + dist_x * scale * diag,
        y: cy + dist_y * scale * diag,
    }
}


/// Dewarp/unwarp source image into an orthographic rectified target buffer using inverse homography sampling
/// and optional radial lens distortion correction (k1).
pub fn dewarp_image(
    src_pixels: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    inv_h: &Homography,
    k1: f32,
    dst_pixels: &mut [u8],
) {
    let src_w_f = src_w as f32;
    let src_h_f = src_h as f32;

    for dy in 0..dst_h {
        let dy_f = dy as f32;
        let dst_row_offset = (dy * dst_w * 4) as usize;

        for dx in 0..dst_w {
            let dx_f = dx as f32;
            let dst_offset = dst_row_offset + (dx * 4) as usize;

            // Map destination pixel back to perspective source coordinates using inverse homography
            let unwarped_pt = inv_h.transform_point(Point2D { x: dx_f, y: dy_f });

            // Apply radial lens distortion to find where this unwarped ray hits the distorted sensor
            let src_pt = apply_radial_distortion(unwarped_pt, src_w_f, src_h_f, k1);

            if src_pt.x >= 0.0 && src_pt.x < src_w_f && src_pt.y >= 0.0 && src_pt.y < src_h_f {
                let sx = src_pt.x as u32;
                let sy = src_pt.y as u32;
                let src_offset = ((sy * src_w + sx) * 4) as usize;

                dst_pixels[dst_offset] = src_pixels[src_offset];
                dst_pixels[dst_offset + 1] = src_pixels[src_offset + 1];
                dst_pixels[dst_offset + 2] = src_pixels[src_offset + 2];
                dst_pixels[dst_offset + 3] = 255;
            } else {
                // Out of bounds background color (pure white mat background)
                dst_pixels[dst_offset] = 255;
                dst_pixels[dst_offset + 1] = 255;
                dst_pixels[dst_offset + 2] = 255;
                dst_pixels[dst_offset + 3] = 255;
            }
        }
    }
}

