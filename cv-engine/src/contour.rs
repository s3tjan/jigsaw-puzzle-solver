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
    pub normalized_profile: Vec<f32>, // 100 equidistant points normalized relative to baseline chord
    pub fourier_descriptor: [f32; 16], // 16 scale- and rotation-invariant Fourier coefficients
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

/// Automatic Otsu threshold calculation
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

/// Applies a 3x3 morphological closing (dilation followed by erosion) to fuse small dropouts
pub fn morphological_close_3x3(input: &[u8], width: u32, height: u32, output: &mut [u8]) {
    let w = width as i32;
    let h = height as i32;
    let total = (width * height) as usize;
    let mut dilated = vec![0u8; total];

    // 1. Dilation
    for y in 0..h {
        for x in 0..w {
            let mut max_val = 0u8;
            for ky in -1..=1 {
                for kx in -1..=1 {
                    let px = (x + kx).clamp(0, w - 1) as usize;
                    let py = (y + ky).clamp(0, h - 1) as usize;
                    let val = input[py * width as usize + px];
                    if val > max_val {
                        max_val = val;
                        if max_val == 255 { break; }
                    }
                }
                if max_val == 255 { break; }
            }
            dilated[(y * w + x) as usize] = max_val;
        }
    }

    // 2. Erosion
    for y in 0..h {
        for x in 0..w {
            let mut min_val = 255u8;
            for ky in -1..=1 {
                for kx in -1..=1 {
                    let px = (x + kx).clamp(0, w - 1) as usize;
                    let py = (y + ky).clamp(0, h - 1) as usize;
                    let val = dilated[py * width as usize + px];
                    if val < min_val {
                        min_val = val;
                        if min_val == 0 { break; }
                    }
                }
                if min_val == 0 { break; }
            }
            output[(y * w + x) as usize] = min_val;
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

        let sx = (p_prev2.x + 4.0 * p_prev1.x + 6.0 * p_curr.x + 4.0 * p_next1.x + p_next2.x) / 16.0;
        let sy = (p_prev2.y + 4.0 * p_prev1.y + 6.0 * p_curr.y + 4.0 * p_next1.y + p_next2.y) / 16.0;

        smoothed.push(Point2D { x: sx, y: sy });
    }
    smoothed
}

/// Extracts the continuous boundary contour using radial-sweep Moore-Neighbor tracing
pub fn trace_piece_contour(
    binary: &[u8],
    width: u32,
    height: u32,
) -> Option<Vec<Point2D>> {
    let w = width as i32;
    let h = height as i32;

    let margin_x = (width as f32 * 0.02) as i32;
    let margin_y = (height as f32 * 0.02) as i32;

    let mut best_contour: Option<Vec<Point2D>> = None;
    let mut best_area = 0.0f32;

    let mut visited = vec![false; (width * height) as usize];

    for y in margin_y..(h - margin_y) {
        for x in margin_x..(w - margin_x) {
            let idx = (y * w + x) as usize;
            if binary[idx] == 255 && !visited[idx] {
                let left_idx = (y * w + (x - 1)) as usize;
                if binary[left_idx] == 0 {
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

                    if raw_contour.len() >= 40 {
                        let mut area: f32 = 0.0;
                        let clen = raw_contour.len();
                        for ci in 0..clen {
                            let p1 = raw_contour[ci];
                            let p2 = raw_contour[(ci + 1) % clen];
                            area += (p1.x * p2.y) - (p2.x * p1.y);
                        }
                        area = (area * 0.5).abs();

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

/// Unified, robust corner and edge partitioner for jigsaw puzzle pieces
pub fn partition_edges_and_classify(contour: &[Point2D]) -> Option<ScannedPiece> {
    if contour.len() < 40 {
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

    // 1. Compute Principal Orientation via 2D Covariance Matrix
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

    let theta = 0.5 * (2.0 * cov_xy).atan2(cov_xx - cov_yy);
    let cos_t = theta.cos();
    let sin_t = theta.sin();

    // 2. Uniform Geometric Corner Detection:
    // Every jigsaw piece has a core rectangular body with 4 physical corners.
    // In the rotated PCA frame (u, v), the 4 physical corners correspond to the 4 quadrant extrema:
    // Top-Left (min u+v), Top-Right (max u-v), Bottom-Right (max u+v), Bottom-Left (min u-v).
    // To be immune to tabs protruding outward or blanks going inward, we project points into
    // the 4 quadrant sectors and find the corner vertex that maximizes distance from centroid
    // while conforming to local curvature turning.

    let k_span = (n as i32 / 28).clamp(5, 12);
    let mut corner_scores = vec![0.0f32; n];

    for i in 0..n {
        let prev = contour[(i as i32 - k_span).rem_euclid(n as i32) as usize];
        let curr = contour[i];
        let next = contour[(i as i32 + k_span).rem_euclid(n as i32) as usize];

        let v1x = curr.x - prev.x;
        let v1y = curr.y - prev.y;
        let v2x = next.x - curr.x;
        let v2y = next.y - curr.y;

        let len1 = (v1x * v1x + v1y * v1y).sqrt().max(1e-4);
        let len2 = (v2x * v2x + v2y * v2y).sqrt().max(1e-4);

        // Dot product between incoming and outgoing tangent vectors:
        // A sharp ~90 degree outer corner has dot product ~ 0.0, turning ~ pi/2
        let dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
        let cross = (v1x * v2y - v1y * v2x) / (len1 * len2);

        // Distance from piece centroid
        let dist_c = ((curr.x - cx) * (curr.x - cx) + (curr.y - cy) * (curr.y - cy)).sqrt();

        // High score for convex outer corner vertices (positive cross turn, low dot product)
        let convexity = cross.max(0.0);
        let sharpness = (1.0 - dot).max(0.0);
        corner_scores[i] = dist_c * (1.0 + convexity * 1.5 + sharpness * 0.8);
    }

    // Partition contour into 4 angular quadrants relative to PCA principal axes
    let mut quad_candidates: [Vec<(usize, f32)>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];

    for (i, p) in contour.iter().enumerate() {
        let dx = p.x - cx;
        let dy = p.y - cy;
        let u = dx * cos_t + dy * sin_t;
        let v = -dx * sin_t + dy * cos_t;

        // Angle in PCA frame in [-PI, PI]
        let angle = v.atan2(u);

        // Assign to 4 quadrants centered at -3pi/4, -pi/4, pi/4, 3pi/4
        let q = if angle >= -std::f32::consts::PI && angle < -std::f32::consts::FRAC_PI_2 {
            0 // Top-Left quadrant
        } else if angle >= -std::f32::consts::FRAC_PI_2 && angle < 0.0 {
            1 // Top-Right quadrant
        } else if angle >= 0.0 && angle < std::f32::consts::FRAC_PI_2 {
            2 // Bottom-Right quadrant
        } else {
            3 // Bottom-Left quadrant
        };

        quad_candidates[q].push((i, corner_scores[i]));
    }

    let mut raw_corners = [0usize; 4];
    for q in 0..4 {
        if quad_candidates[q].is_empty() {
            return None;
        }
        // Pick highest scoring corner vertex in this quadrant
        quad_candidates[q].sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        raw_corners[q] = quad_candidates[q][0].0;
    }

    // Sort corners sequentially along the contour
    raw_corners.sort();

    // Verify minimum separation between corners (at least 12% of perimeter each)
    let min_sep = (n as f32 * 0.12) as usize;
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

    // 3. Partition 4 Edges and Classify
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
        let mut sum_dist = 0.0f32;
        let mut sum_dist_sq = 0.0f32;
        let n_samples = samples.len().max(1) as f32;

        for s in &samples {
            let dist = ((s.x - p_start.x) * base_dy - (s.y - p_start.y) * base_dx) / base_len;
            if dist.abs() > max_signed_dist.abs() {
                max_signed_dist = dist;
            }
            sum_dist += dist;
            sum_dist_sq += dist * dist;
        }

        let mean_dist = sum_dist / n_samples;
        let variance = (sum_dist_sq / n_samples - mean_dist * mean_dist).max(0.0);
        let std_dev = variance.sqrt();

        // Center signed distance to determine tab (outward) vs hole (inward)
        let mid_x = (p_start.x + p_end.x) * 0.5;
        let mid_y = (p_start.y + p_end.y) * 0.5;
        let center_dx = cx - mid_x;
        let center_dy = cy - mid_y;
        let center_signed_dist = (center_dx * base_dy - center_dy * base_dx) / base_len;

        let rel_depth = max_signed_dist.abs() / base_len;

        // Clean edge classification:
        // A true Flat boundary edge has low relative deviation (< 0.13) and low standard deviation (< 3.8px)
        let edge_type = if rel_depth < 0.13 && std_dev < 3.8 {
            EdgeType::Flat
        } else if (max_signed_dist * center_signed_dist) > 0.0 {
            EdgeType::Hole
        } else {
            EdgeType::Tab
        };

        // Resample edge into 100 normalized points
        let mut norm_profile = Vec::with_capacity(100);
        let n_s = samples.len();
        for k in 0..100 {
            let t = k as f32 / 99.0;
            let sample_idx = ((t * (n_s - 1) as f32).round() as usize).min(n_s - 1);
            let s = samples[sample_idx];
            let dist_to_chord = ((s.x - p_start.x) * base_dy - (s.y - p_start.y) * base_dx) / base_len;
            norm_profile.push(dist_to_chord / base_len);
        }

        // 16 Fourier Descriptors
        let mut fourier = [0.0f32; 16];
        for k in 1..=16 {
            let mut re = 0.0f32;
            let mut im = 0.0f32;
            for (m, &val) in norm_profile.iter().enumerate() {
                let angle = 2.0 * std::f32::consts::PI * (k as f32) * (m as f32) / 100.0;
                re += val * angle.cos();
                im -= val * angle.sin();
            }
            fourier[k - 1] = (re * re + im * im).sqrt() / 100.0;
        }

        edges_vec.push(PieceEdge {
            edge_type,
            start_corner: p_start,
            end_corner: p_end,
            curvature_depth: max_signed_dist,
            curve_samples: samples,
            normalized_profile: norm_profile,
            fourier_descriptor: fourier,
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
