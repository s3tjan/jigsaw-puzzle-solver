use crate::homography::Point2D;

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, PartialEq)]
pub enum EdgeType {
    Flat, // Puzzle outer boundary (corner / border pieces)
    Tab,  // Male interlocking protrusion
    Hole, // Female interlocking blank / indentation
}

/// Represents one of the 4 cardinal edges of a puzzle piece
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PieceEdge {
    pub edge_type: EdgeType,
    pub start_corner: Point2D,
    pub end_corner: Point2D,
    pub curvature_depth: f32, // Positive = Tab, Negative = Hole, ~0 = Flat
    pub curve_samples: Vec<Point2D>, // Dense smoothed contour points
}

/// Complete geometric profile of a scanned puzzle piece
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ScannedPiece {
    pub center: Point2D,
    pub rotation_angle_rad: f32,
    pub bounding_width: f32,
    pub bounding_height: f32,
    pub perimeter_length: f32,
    pub corners: [Point2D; 4], // 4 physical corners of the piece core
    pub edges: [PieceEdge; 4], // Top, Right, Bottom, Left
    pub contour_points: Vec<Point2D>,
    pub is_corner: bool,
    pub is_border: bool,
}

/// Automatic Otsu threshold calculation for separating the piece from the white staging arena
pub fn compute_otsu_threshold(grayscale: &[u8]) -> u8 {
    let mut histogram = [0u32; 256];
    for &val in grayscale {
        histogram[val as usize] += 1;
    }

    let total = grayscale.len() as f64;
    if total == 0.0 {
        return 128;
    }

    let mut sum_all: f64 = 0.0;
    for t in 0..256 {
        sum_all += t as f64 * histogram[t] as f64;
    }

    let mut sum_bg: f64 = 0.0;
    let mut weight_bg: f64 = 0.0;
    let mut max_variance: f64 = 0.0;
    let mut best_thresh: u8 = 128;

    for t in 0..256 {
        weight_bg += histogram[t] as f64;
        if weight_bg == 0.0 {
            continue;
        }
        let weight_fg = total - weight_bg;
        if weight_fg == 0.0 {
            break;
        }

        sum_bg += t as f64 * histogram[t] as f64;
        let mean_bg = sum_bg / weight_bg;
        let mean_fg = (sum_all - sum_bg) / weight_fg;

        let var_between = weight_bg * weight_fg * (mean_bg - mean_fg) * (mean_bg - mean_fg);
        if var_between > max_variance {
            max_variance = var_between;
            best_thresh = t as u8;
        }
    }

    best_thresh
}

/// Applies a 3x3 Gaussian smoothing kernel on grayscale to eliminate cardboard fiber noise
pub fn gaussian_blur_3x3(input: &[u8], width: u32, height: u32, output: &mut [u8]) {
    let w = width as i32;
    let h = height as i32;

    // Kernel weights: [1, 2, 1; 2, 4, 2; 1, 2, 1] / 16
    for y in 0..h {
        for x in 0..w {
            let mut sum: u32 = 0;
            for ky in -1..=1 {
                for kx in -1..=1 {
                    let px = (x + kx).clamp(0, w - 1) as usize;
                    let py = (y + ky).clamp(0, h - 1) as usize;
                    let val = input[py * width as usize + px] as u32;

                    let weight = match (kx.abs(), ky.abs()) {
                        (1, 1) => 1,
                        (0, 1) | (1, 0) => 2,
                        _ => 4,
                    };
                    sum += val * weight;
                }
            }
            output[(y * w + x) as usize] = (sum / 16) as u8;
        }
    }
}

/// Smooths a closed contour polygon using a 5-point Gaussian moving window
pub fn smooth_contour_points(points: &[Point2D]) -> Vec<Point2D> {
    let n = points.len();
    if n < 5 {
        return points.to_vec();
    }

    let mut smoothed = Vec::with_capacity(n);
    for i in 0..n {
        let p_prev2 = points[(i + n - 2) % n];
        let p_prev1 = points[(i + n - 1) % n];
        let p_curr  = points[i];
        let p_next1 = points[(i + 1) % n];
        let p_next2 = points[(i + 2) % n];

        // 1-4-6-4-1 binomial filter weights
        let sx = (p_prev2.x + 4.0 * p_prev1.x + 6.0 * p_curr.x + 4.0 * p_next1.x + p_next2.x) / 16.0;
        let sy = (p_prev2.y + 4.0 * p_prev1.y + 6.0 * p_curr.y + 4.0 * p_next1.y + p_next2.y) / 16.0;

        smoothed.push(Point2D { x: sx, y: sy });
    }
    smoothed
}

/// Extracts the continuous boundary contour using radial-sweep Moore-Neighbor tracing.
/// Searches for significant closed foreground contours without strict 8% margin clipping.
pub fn trace_piece_contour(
    binary: &[u8],
    width: u32,
    height: u32,
) -> Option<Vec<Point2D>> {
    let w = width as i32;
    let h = height as i32;

    // Small boundary margin to avoid touching image outer border
    let margin_x = (width as f32 * 0.03) as i32;
    let margin_y = (height as f32 * 0.03) as i32;

    let mut best_contour: Option<Vec<Point2D>> = None;
    let mut best_area = 0.0f32;

    // We keep track of visited pixels to avoid repeatedly re-tracing small noise specs
    let mut visited = vec![false; (width * height) as usize];

    for y in (margin_y..(h - margin_y)).step_by(2) {
        for x in (margin_x..(w - margin_x)).step_by(2) {
            let idx = (y * w + x) as usize;
            if binary[idx] == 255 && !visited[idx] {
                let left_idx = (y * w + (x - 1)) as usize;
                if binary[left_idx] == 0 {
                    // Candidate contour start
                    let sx = x;
                    let sy = y;
                    let mut raw_contour = Vec::new();

                    let dx = [-1,  0,  1,  1,  1,  0, -1, -1];
                    let dy = [-1, -1, -1,  0,  1,  1,  1,  0];

                    let mut curr_x = sx;
                    let mut curr_y = sy;
                    let mut backtrack_dir = 0;

                    raw_contour.push(Point2D { x: sx as f32, y: sy as f32 });
                    visited[idx] = true;

                    let max_steps = (width * height) as usize;
                    for _ in 0..max_steps {
                        let mut next_found = false;
                        let start_dir = (backtrack_dir + 5) % 8;

                        for i in 0..8 {
                            let dir = (start_dir + i) % 8;
                            let nx = curr_x + dx[dir];
                            let ny = curr_y + dy[dir];

                            if nx >= 0 && nx < w && ny >= 0 && ny < h {
                                let nidx = (ny * w + nx) as usize;
                                visited[nidx] = true;
                                if binary[nidx] == 255 {
                                    curr_x = nx;
                                    curr_y = ny;
                                    backtrack_dir = dir;
                                    raw_contour.push(Point2D { x: nx as f32, y: ny as f32 });
                                    next_found = true;
                                    break;
                                }
                            }
                        }

                        if !next_found || (curr_x == sx && curr_y == sy) {
                            break;
                        }
                    }

                    // A piece taking 1/3 of the inner square (~120px perimeter in 384x384)
                    // has perimeter >= 35 points
                    if raw_contour.len() >= 35 {
                        // Calculate approximate polygon area via Shoelace formula
                        let mut area: f32 = 0.0;
                        let clen = raw_contour.len();
                        for ci in 0..clen {
                            let p1 = raw_contour[ci];
                            let p2 = raw_contour[(ci + 1) % clen];
                            area += (p1.x * p2.y) - (p2.x * p1.y);
                        }
                        area = (area * 0.5).abs();

                        // Discard tiny artifacts or full-canvas border boxes
                        let max_valid_area = (width * height) as f32 * 0.85;
                        let min_valid_area = (width * height) as f32 * 0.005;

                        if area >= min_valid_area && area <= max_valid_area {
                            if area > best_area {
                                best_area = area;
                                best_contour = Some(raw_contour);
                            }
                        }
                    }
                }
            }
        }
    }

    best_contour.map(|c| smooth_contour_points(&c))
}

/// Robust rotation-invariant corner finder using Principal Component Analysis (PCA)
/// and local curvature analysis on oriented bounding axes
pub fn partition_edges_and_classify(contour: &[Point2D]) -> Option<ScannedPiece> {
    if contour.len() < 35 {
        return None;
    }

    let n = contour.len();
    let mut cx = 0.0;
    let mut cy = 0.0;
    for p in contour {
        cx += p.x;
        cy += p.y;
    }
    cx /= n as f32;
    cy /= n as f32;

    // 1. Compute 2D Covariance Matrix for Principal Orientation
    let mut cov_xx = 0.0;
    let mut cov_xy = 0.0;
    let mut cov_yy = 0.0;

    for p in contour {
        let dx = p.x - cx;
        let dy = p.y - cy;
        cov_xx += dx * dx;
        cov_xy += dx * dy;
        cov_yy += dy * dy;
    }

    // Principal angle theta
    let theta = 0.5 * (2.0 * cov_xy).atan2(cov_xx - cov_yy);
    let cos_t = theta.cos();
    let sin_t = theta.sin();

    // 2. Project all points onto the rotated principal axes:
    // u = dx * cos - dy * sin, v = dx * sin + dy * cos
    let mut idx_tl = 0;
    let mut idx_tr = 0;
    let mut idx_br = 0;
    let mut idx_bl = 0;

    let mut score_tl = f32::MAX;
    let mut score_tr = f32::MIN;
    let mut score_br = f32::MIN;
    let mut score_bl = f32::MAX;

    for (i, p) in contour.iter().enumerate() {
        let dx = p.x - cx;
        let dy = p.y - cy;
        let u = dx * cos_t + dy * sin_t;
        let v = -dx * sin_t + dy * cos_t;

        // In rotated frame, 4 quadrant corners are independent of mat orientation
        let s_tl = u + v;
        if s_tl < score_tl { score_tl = s_tl; idx_tl = i; }

        let s_tr = u - v;
        if s_tr > score_tr { score_tr = s_tr; idx_tr = i; }

        let s_br = u + v;
        if s_br > score_br { score_br = s_br; idx_br = i; }

        let s_bl = u - v;
        if s_bl < score_bl { score_bl = s_bl; idx_bl = i; }
    }

    // 3. Local curvature refinement: Search within +/- 8 points for highest corner angle
    let refine_corner = |approx_idx: usize| -> usize {
        let mut best_idx = approx_idx;
        let mut min_dot = f32::MAX;

        for offset in -8..=8 {
            let idx = (approx_idx as i32 + offset).rem_euclid(n as i32) as usize;
            let prev = contour[(idx + n - 6) % n];
            let curr = contour[idx];
            let next = contour[(idx + 6) % n];

            let v1x = prev.x - curr.x;
            let v1y = prev.y - curr.y;
            let v2x = next.x - curr.x;
            let v2y = next.y - curr.y;

            let len1 = (v1x * v1x + v1y * v1y).sqrt().max(1e-4);
            let len2 = (v2x * v2x + v2y * v2y).sqrt().max(1e-4);

            // Dot product evaluates right-angle (~0 dot product)
            let dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
            if dot < min_dot {
                min_dot = dot;
                best_idx = idx;
            }
        }
        best_idx
    };

    let c0 = refine_corner(idx_tl);
    let c1 = refine_corner(idx_tr);
    let c2 = refine_corner(idx_br);
    let c3 = refine_corner(idx_bl);

    let mut raw_corners = [c0, c1, c2, c3];
    // Sort corner indices strictly along the contour sequence so that edge traversal
    // always progresses forward along the perimeter without wrapping backward
    raw_corners.sort();

    // Verify minimum separation between corners (at least 5% of perimeter each)
    let min_sep = (n as f32 * 0.06) as usize;
    for i in 0..4 {
        let diff = (raw_corners[(i + 1) % 4] + n - raw_corners[i]) % n;
        if diff < min_sep {
            return None; // Degenerate corner collapse
        }
    }

    let corners = [
        contour[raw_corners[0]],
        contour[raw_corners[1]],
        contour[raw_corners[2]],
        contour[raw_corners[3]],
    ];

    // 4. Partition 4 Edges and Classify
    let mut edges_vec = Vec::with_capacity(4);

    for e in 0..4 {
        let start_i = raw_corners[e];
        let end_i = raw_corners[(e + 1) % 4];

        let mut samples = Vec::new();
        let mut curr = start_i;
        while curr != end_i {
            samples.push(contour[curr]);
            curr = (curr + 1) % n;
        }
        samples.push(contour[end_i]);

        let p_start = contour[start_i];
        let p_end = contour[end_i];
        let base_dx = p_end.x - p_start.x;
        let base_dy = p_end.y - p_start.y;
        let base_len = (base_dx * base_dx + base_dy * base_dy).sqrt().max(1.0);

        let mut max_signed_dist: f32 = 0.0;
        for s in &samples {
            // Signed perpendicular distance: positive = tab protruding outward, negative = hole
            let dist = ((s.x - p_start.x) * base_dy - (s.y - p_start.y) * base_dx) / base_len;
            if dist.abs() > max_signed_dist.abs() {
                max_signed_dist = dist;
            }
        }

        // Compute standard deviation of distance to line to ensure edge is genuinely flat and straight
        let mut sum_dist = 0.0f32;
        let mut sum_dist_sq = 0.0f32;
        let n_samples = samples.len().max(1) as f32;
        for s in &samples {
            let dist = ((s.x - p_start.x) * base_dy - (s.y - p_start.y) * base_dx) / base_len;
            sum_dist += dist;
            sum_dist_sq += dist * dist;
        }
        let mean_dist = sum_dist / n_samples;
        let variance = (sum_dist_sq / n_samples - mean_dist * mean_dist).max(0.0);
        let std_dev = variance.sqrt();

        let rel_depth = max_signed_dist / base_len;
        // A true Flat jigsaw edge is straight: minimal peak deviation (< 0.06 base_len) AND low deviation (< 2.8px)
        let edge_type = if rel_depth.abs() < 0.06 && std_dev < 2.8 {
            EdgeType::Flat
        } else if rel_depth > 0.0 {
            EdgeType::Tab
        } else {
            EdgeType::Hole
        };

        edges_vec.push(PieceEdge {
            edge_type,
            start_corner: p_start,
            end_corner: p_end,
            curvature_depth: max_signed_dist,
            curve_samples: samples,
        });
    }

    let flat_count = edges_vec.iter().filter(|e| e.edge_type == EdgeType::Flat).count();
    let is_corner = flat_count == 2;
    let is_border = flat_count == 1;

    let edges = [
        edges_vec[0].clone(),
        edges_vec[1].clone(),
        edges_vec[2].clone(),
        edges_vec[3].clone(),
    ];

    // Canonicalize orientation angle to [0, pi) for stability
    let canonical_theta = if theta < 0.0 { theta + std::f32::consts::PI } else { theta };

    Some(ScannedPiece {
        center: Point2D { x: cx, y: cy },
        rotation_angle_rad: canonical_theta,
        bounding_width: (corners[1].x - corners[0].x).abs().max((corners[2].x - corners[3].x).abs()),
        bounding_height: (corners[3].y - corners[0].y).abs().max((corners[2].y - corners[1].y).abs()),
        perimeter_length: contour.len() as f32,
        corners,
        edges,
        contour_points: contour.to_vec(),
        is_corner,
        is_border,
    })
}
