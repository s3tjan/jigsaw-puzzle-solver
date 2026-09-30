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

/// Smooths a closed contour polygon using an iterated Gaussian moving window to eliminate discrete raster steps
pub fn smooth_contour_points(points: &[Point2D]) -> Vec<Point2D> {
    let n = points.len();
    if n < 5 {
        return points.to_vec();
    }

    let mut current = points.to_vec();
    let mut next = Vec::with_capacity(n);

    // Apply 3 passes of 5-point binomial Gaussian filter [1, 4, 6, 4, 1] / 16
    for _ in 0..3 {
        next.clear();
        for i in 0..n {
            let p_prev2 = current[(i + n - 2) % n];
            let p_prev1 = current[(i + n - 1) % n];
            let p_curr  = current[i];
            let p_next1 = current[(i + 1) % n];
            let p_next2 = current[(i + 2) % n];

            let sx = (p_prev2.x + 4.0 * p_prev1.x + 6.0 * p_curr.x + 4.0 * p_next1.x + p_next2.x) / 16.0;
            let sy = (p_prev2.y + 4.0 * p_prev1.y + 6.0 * p_curr.y + 4.0 * p_next1.y + p_next2.y) / 16.0;

            next.push(Point2D { x: sx, y: sy });
        }
        std::mem::swap(&mut current, &mut next);
    }

    current
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

    // 1. Calculate estimated piece radius for scale normalization:
    let r_est = {
        let mut sum_r = 0.0f32;
        for p in contour {
            sum_r += ((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy)).sqrt();
        }
        (sum_r / n as f32).max(10.0)
    };
    let scale_norm = 45.0 / r_est; // Normalize to nominal ~45px radius

    // Detect physical straight line segments (die-cut flat border edges for classification)
    let mut best_line: Option<(usize, usize, f32)> = None;
    let max_span = (n / 3).min(90);
    for span in (40..=max_span).step_by(5) {
        for i in (0..n).step_by(3) {
            let mut sum_x = 0.0f32;
            let mut sum_y = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                sum_x += pt.x;
                sum_y += pt.y;
            }
            let mx = sum_x / (span as f32);
            let my = sum_y / (span as f32);
            let mut cxx = 0.0f32;
            let mut cyy = 0.0f32;
            let mut cxy = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                let dx = pt.x - mx;
                let dy = pt.y - my;
                cxx += dx * dx;
                cyy += dy * dy;
                cxy += dx * dy;
            }
            cxx /= span as f32;
            cyy /= span as f32;
            cxy /= span as f32;
            let tr = cxx + cyy;
            let det = cxx * cyy - cxy * cxy;
            let diff = (tr * tr - 4.0 * det).max(0.0).sqrt();
            let std_res = (0.5 * (tr - diff)).max(0.0).sqrt();

            let p0 = contour[i];
            let p1 = contour[(i + span) % n];
            let chord = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt();
            if std_res < 0.45 && chord > 50.0 {
                if best_line.is_none() || span > best_line.unwrap().0 {
                    let angle = (p1.y - p0.y).atan2(p1.x - p0.x);
                    best_line = Some((span, i, angle));
                }
            }
        }
    }

    // 2. Modulo-90 Straight Linear Segment Voting (detects tab necks, shoulders, and flat cuts):
    let mut segments: Vec<(f32, f32)> = Vec::new();
    for &span in &[16usize, 20, 24] {
        if span >= n { continue; }
        for i in (0..n).step_by(2) {
            let mut sum_x = 0.0f32;
            let mut sum_y = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                sum_x += pt.x;
                sum_y += pt.y;
            }
            let mx = sum_x / (span as f32);
            let my = sum_y / (span as f32);
            let mut cxx = 0.0f32;
            let mut cyy = 0.0f32;
            let mut cxy = 0.0f32;
            for k in 0..span {
                let pt = contour[(i + k) % n];
                let dx = pt.x - mx;
                let dy = pt.y - my;
                cxx += dx * dx;
                cyy += dy * dy;
                cxy += dx * dy;
            }
            cxx /= span as f32;
            cyy /= span as f32;
            cxy /= span as f32;
            let tr = cxx + cyy;
            let det = cxx * cyy - cxy * cxy;
            let diff = (tr * tr - 4.0 * det).max(0.0).sqrt();
            let std_res = (0.5 * (tr - diff)).max(0.0).sqrt();

            let p0 = contour[i];
            let p1 = contour[(i + span) % n];
            let chord = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt();
            if std_res < 0.40 && chord > 12.0 {
                let ang = (p1.y - p0.y).atan2(p1.x - p0.x);
                segments.push((ang, chord));
            }
        }
    }

    let mut cov_xx = 0.0f32;
    let mut cov_xy = 0.0f32;
    let mut cov_yy = 0.0f32;
    for p in contour {
        let dx = p.x - cx;
        let dy = p.y - cy;
        cov_xx += dx * dx;
        cov_xy += dx * dy;
        cov_yy += dy * dy;
    }
    let pca_t = 0.5 * (2.0 * cov_xy).atan2(cov_xx - cov_yy);

    let k_span = (n / 36).clamp(8, 16) as i32;
    let mut point_features = Vec::with_capacity(n);
    let mut top_corners: Vec<(usize, f32)> = Vec::with_capacity(n);

    for i in 0..n {
        let prev = contour[(i as i32 - k_span).rem_euclid(n as i32) as usize];
        let curr = contour[i];
        let next = contour[(i as i32 + k_span).rem_euclid(n as i32) as usize];

        let v1x = curr.x - prev.x; let v1y = curr.y - prev.y;
        let v2x = next.x - curr.x; let v2y = next.y - curr.y;

        let len1 = (v1x * v1x + v1y * v1y).sqrt().max(1e-4);
        let len2 = (v2x * v2x + v2y * v2y).sqrt().max(1e-4);

        let dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
        let cross = (v1x * v2y - v1y * v2x) / (len1 * len2);

        let dx = curr.x - cx;
        let dy = curr.y - cy;
        let dist_c = (dx * dx + dy * dy).sqrt();
        let dist_bounded = dist_c.min(r_est * 1.25);

        let convexity = cross.max(0.0);
        let sharpness = (1.0 - dot).max(0.0);
        let base_score = (dist_bounded * scale_norm) * (1.0 + convexity * 2.0 + sharpness * 2.5);

        point_features.push((dx, dy, base_score));
        top_corners.push((i, base_score));
    }

    top_corners.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut filtered_corners = Vec::with_capacity(6);
    for &(idx, sc) in &top_corners {
        let too_close = filtered_corners.iter().any(|&(f_idx, _): &(usize, f32)| {
            let dist = ((idx as i32 - f_idx as i32).abs() as usize).min(n - (idx as i32 - f_idx as i32).abs() as usize);
            dist < 15
        });
        if !too_close {
            filtered_corners.push((idx, sc));
            if filtered_corners.len() >= 6 { break; }
        }
    }

    let mut pairwise_thetas: Vec<f32> = Vec::new();
    'outer: for i in 0..filtered_corners.len() {
        let p1 = contour[filtered_corners[i].0];
        for j in (i+1)..filtered_corners.len() {
            let p2 = contour[filtered_corners[j].0];
            let dist = ((p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2)).sqrt();
            if dist > 35.0 {
                let ang = (p2.y - p1.y).atan2(p2.x - p1.x);
                let mut deg = ang.to_degrees().rem_euclid(90.0);
                if deg >= 45.0 { deg -= 90.0; }
                let t = deg.to_radians();
                if !pairwise_thetas.iter().any(|&ct| (ct - t).abs() < 0.08) {
                    pairwise_thetas.push(t);
                    if pairwise_thetas.len() >= 2 { break 'outer; }
                }
            }
        }
    }

    let candidate_thetas: Vec<f32> = if segments.len() >= 5 {
        let mut angle_bins = [0.0f32; 90];
        for (ang, chord) in &segments {
            let mut deg = ang.to_degrees().rem_euclid(90.0);
            if deg >= 45.0 { deg -= 90.0; }
            let bin_idx = ((deg.round() as i32) + 45).clamp(0, 89) as usize;
            angle_bins[bin_idx] += chord;
        }

        let mut bin_indices: Vec<usize> = (0..90).collect();
        bin_indices.sort_by(|&a, &b| angle_bins[b].partial_cmp(&angle_bins[a]).unwrap_or(std::cmp::Ordering::Equal));

        let best_bin1 = bin_indices[0];
        let t1 = ((best_bin1 as f32 - 45.0)).to_radians();

        let mut cands = vec![t1];

        let mut best_bin2 = None;
        let mut best_bin2_votes = 0.0f32;
        for &b in &bin_indices[1..] {
            let diff = (b as i32 - best_bin1 as i32).abs();
            if diff >= 20 && diff <= 70 {
                if angle_bins[b] > best_bin2_votes {
                    best_bin2_votes = angle_bins[b];
                    best_bin2 = Some(b);
                }
            }
        }
        if let Some(b2) = best_bin2 {
            if best_bin2_votes >= angle_bins[best_bin1] * 0.15 {
                let t2 = ((b2 as f32 - 45.0)).to_radians();
                if !cands.iter().any(|&t| (t - t2).abs() < 0.1) {
                    cands.push(t2);
                }
            }
        }

        if let Some((_, _, bl_ang)) = best_line {
            let mut bl_deg = bl_ang.to_degrees().rem_euclid(90.0);
            if bl_deg >= 45.0 { bl_deg -= 90.0; }
            let bl_t = bl_deg.to_radians();
            if !cands.iter().any(|&t| (t - bl_t).abs() < 0.1) {
                cands.push(bl_t);
            }
        }

        if !cands.iter().any(|&t| (t - pca_t).abs() < 0.1) {
            cands.push(pca_t);
        }

        for &pt in &pairwise_thetas {
            if !cands.iter().any(|&t| (t - pt).abs() < 0.1) {
                cands.push(pt);
            }
        }

        for deg in (-42..=42).step_by(5) {
            let t = (deg as f32).to_radians();
            if !cands.iter().any(|&ct| (ct - t).abs() < 0.05) {
                cands.push(t);
            }
        }
        cands
    } else {
        let mut cands = vec![pca_t];
        for &pt in &pairwise_thetas {
            if !cands.iter().any(|&t| (t - pt).abs() < 0.1) {
                cands.push(pt);
            }
        }
        for deg in (-42..=42).step_by(5) {
            let t = (deg as f32).to_radians();
            if !cands.iter().any(|&ct| (ct - t).abs() < 0.05) {
                cands.push(t);
            }
        }
        cands
    };

    let tr = cov_xx + cov_yy;
    let det = cov_xx * cov_yy - cov_xy * cov_xy;
    let diff = (tr * tr - 4.0 * det).max(0.0).sqrt();
    let l1 = 0.5 * (tr + diff);
    let l2 = (0.5 * (tr - diff)).max(1e-3);
    let pca_aspect = (l1 / l2).sqrt();
    let use_rect_norm = pca_aspect > 1.20;

    let mut best_global_quad = None;
    let mut best_global_score = -1e9f32;
    let mut best_chosen_theta = candidate_thetas[0];

    for &cand_t in &candidate_thetas {
        let mut theta = cand_t;
        while theta <= -std::f32::consts::FRAC_PI_4 {
            theta += std::f32::consts::FRAC_PI_2;
        }
        while theta > std::f32::consts::FRAC_PI_4 {
            theta -= std::f32::consts::FRAC_PI_2;
        }
        let cos_t = theta.cos();
        let sin_t = theta.sin();

        // Aspect-ratio normalization: find maximum extent along u and v axes
        let mut max_u = 1.0f32;
        let mut max_v = 1.0f32;
        for p in contour {
            let dx = p.x - cx;
            let dy = p.y - cy;
            let u = (dx * cos_t + dy * sin_t).abs();
            let v = (-dx * sin_t + dy * cos_t).abs();
            if u > max_u { max_u = u; }
            if v > max_v { max_v = v; }
        }

        let mut corner_scores = vec![0.0f32; n];
        for i in 0..n {
            let (dx, dy, base_score) = point_features[i];

            let (u_norm, v_norm) = if use_rect_norm {
                ((dx * cos_t + dy * sin_t).abs() / max_u, (-dx * sin_t + dy * cos_t).abs() / max_v)
            } else {
                ((dx * cos_t + dy * sin_t).abs(), (-dx * sin_t + dy * cos_t).abs())
            };

            let ratio = (u_norm.min(v_norm) / u_norm.max(v_norm).max(1e-3)).min(1.0);
            let diagonal_balance = 0.4 + 0.6 * ratio;

            corner_scores[i] = base_score * diagonal_balance;
        }

        let mut raw_q_cands: [Vec<(usize, f32)>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        for (i, p) in contour.iter().enumerate() {
            let dx = p.x - cx;
            let dy = p.y - cy;
            let u = dx * cos_t + dy * sin_t;
            let v = -dx * sin_t + dy * cos_t;

            let q = if u < 0.0 && v < 0.0 { 0 }
                    else if u >= 0.0 && v < 0.0 { 1 }
                    else if u >= 0.0 && v >= 0.0 { 2 }
                    else { 3 };

            raw_q_cands[q].push((i, corner_scores[i]));
        }

        let mut q_cands: [Vec<(usize, f32)>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
        for q in 0..4 {
            raw_q_cands[q].sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let mut filtered = Vec::with_capacity(25);
            for &(idx, sc) in &raw_q_cands[q] {
                let too_close = filtered.iter().any(|&(f_idx, _): &(usize, f32)| {
                    let dist = ((idx as i32 - f_idx as i32).abs() as usize).min(n - (idx as i32 - f_idx as i32).abs() as usize);
                    dist < 5
                });
                if !too_close {
                    filtered.push((idx, sc));
                    if filtered.len() >= 25 { break; }
                }
            }
            q_cands[q] = filtered;
        }

        if q_cands[0].is_empty() || q_cands[1].is_empty() || q_cands[2].is_empty() || q_cands[3].is_empty() {
            continue;
        }

        let mut cand_best_quad = None;
        let mut cand_best_score = -1e9f32;

        for &(c0_idx, sc0) in &q_cands[0] {
            let p0 = contour[c0_idx];
            for &(c1_idx, sc1) in &q_cands[1] {
                let p1 = contour[c1_idx];
                for &(c2_idx, sc2) in &q_cands[2] {
                    let p2 = contour[c2_idx];
                    for &(c3_idx, sc3) in &q_cands[3] {
                        let p3 = contour[c3_idx];

                        let mid_x_diff = (p0.x + p2.x) - (p1.x + p3.x);
                        let mid_y_diff = (p0.y + p2.y) - (p1.y + p3.y);
                        let mid_err = (mid_x_diff * 0.5 * mid_x_diff * 0.5 + mid_y_diff * 0.5 * mid_y_diff * 0.5).sqrt() * scale_norm;

                        let d01 = ((p1.x - p0.x).powi(2) + (p1.y - p0.y).powi(2)).sqrt() * scale_norm;
                        let d23 = ((p3.x - p2.x).powi(2) + (p3.y - p2.y).powi(2)).sqrt() * scale_norm;
                        let d12 = ((p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2)).sqrt() * scale_norm;
                        let d30 = ((p0.x - p3.x).powi(2) + (p0.y - p3.y).powi(2)).sqrt() * scale_norm;

                        let edge_diff = (d01 - d23).abs() + (d12 - d30).abs();
                        let prelim_sc = (sc0 + sc1 + sc2 + sc3) - (mid_err * 6.0) - (edge_diff * 1.5);
                        if prelim_sc <= cand_best_score {
                            continue;
                        }

                        // Tab-cut zero-crossing check
                        let quad_indices = [c0_idx, c1_idx, c2_idx, c3_idx];
                        let quad_pts = [p0, p1, p2, p3];
                        let mut tab_cut_penalty = 0.0f32;

                        for e in 0..4 {
                            let s_i = quad_indices[e];
                            let e_i = quad_indices[(e + 1) % 4];
                            let ps = quad_pts[e];
                            let pe = quad_pts[(e + 1) % 4];

                            let b_dx = pe.x - ps.x; let b_dy = pe.y - ps.y;
                            let b_len = (b_dx * b_dx + b_dy * b_dy).sqrt().max(1.0);

                            let fwd_span = (e_i + n - s_i) % n;
                            let (step, count) = if fwd_span <= n / 2 {
                                (1, fwd_span)
                            } else {
                                (n - 1, (s_i + n - e_i) % n)
                            };

                            let mut curr_idx = (s_i + step) % n;
                            let mut step_count = 1;
                            let mut has_pos = false;
                            let mut has_neg = false;

                            while step_count < count {
                                let pt = contour[curr_idx];
                                let dist = (((pt.x - ps.x) * b_dy - (pt.y - ps.y) * b_dx) / b_len) * scale_norm;
                                if dist > 8.0 { has_pos = true; }
                                if dist < -8.0 { has_neg = true; }
                                curr_idx = (curr_idx + step) % n;
                                step_count += 1;
                            }

                            if has_pos && has_neg {
                                tab_cut_penalty += 300.0;
                            }
                        }

                        let total_sc = (sc0 + sc1 + sc2 + sc3) - (mid_err * 6.0) - (edge_diff * 1.5) - tab_cut_penalty;

                        if total_sc > cand_best_score {
                            cand_best_score = total_sc;
                            cand_best_quad = Some([c0_idx, c1_idx, c2_idx, c3_idx]);
                        }
                    }
                }
            }
        }

        if let Some(q_idx) = cand_best_quad {
            if contour.len() == 446 {
                eprintln!("   theta={:.2} deg (raw={:.2} deg), score={:.1}, quad={:?}, pts=[{:?}, {:?}, {:?}, {:?}]",
                    theta.to_degrees(), cand_t.to_degrees(), cand_best_score, q_idx,
                    contour[q_idx[0]], contour[q_idx[1]], contour[q_idx[2]], contour[q_idx[3]]);
            }
            if cand_best_score > best_global_score {
                best_global_score = cand_best_score;
                best_global_quad = Some(q_idx);
                best_chosen_theta = theta;
            }
        }
    }

    let best_q_idx = best_global_quad?;
    let theta = best_chosen_theta;

    let mut corners = [
        contour[best_q_idx[0]], // TL
        contour[best_q_idx[1]], // TR
        contour[best_q_idx[2]], // BR
        contour[best_q_idx[3]], // BL
    ];

    // Sub-pixel line-line intersection refinement for rounded corner tips
    for i in 0..4 {
        let c_idx = best_q_idx[i];
        let curr_p = contour[c_idx];

        let mut in_pts = Vec::with_capacity(12);
        for k in 3..=14 {
            let idx = (c_idx as i32 - k).rem_euclid(n as i32) as usize;
            in_pts.push(contour[idx]);
        }

        let mut out_pts = Vec::with_capacity(12);
        for k in 3..=14 {
            let idx = (c_idx + k) % n;
            out_pts.push(contour[idx]);
        }

        let fit_line = |pts: &[Point2D]| -> Option<(f32, f32, f32, f32)> {
            let m = pts.len() as f32;
            if m < 4.0 { return None; }
            let mut mx = 0.0f32; let mut my = 0.0f32;
            for p in pts { mx += p.x; my += p.y; }
            mx /= m; my /= m;
            let mut cxx = 0.0f32; let mut cyy = 0.0f32; let mut cxy = 0.0f32;
            for p in pts {
                let dx = p.x - mx; let dy = p.y - my;
                cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
            }
            let ang = 0.5 * (2.0 * cxy).atan2(cxx - cyy);
            Some((mx, my, ang.cos(), ang.sin()))
        };

        if let (Some((mx1, my1, dx1, dy1)), Some((mx2, my2, dx2, dy2))) = (fit_line(&in_pts), fit_line(&out_pts)) {
            let a1 = dy1; let b1 = -dx1; let c1 = mx1 * dy1 - my1 * dx1;
            let a2 = dy2; let b2 = -dx2; let c2 = mx2 * dy2 - my2 * dx2;

            let det = a1 * b2 - a2 * b1;
            if det.abs() > 0.25 {
                let ix = (c1 * b2 - c2 * b1) / det;
                let iy = (a1 * c2 - a2 * c1) / det;

                let err = ((ix - curr_p.x).powi(2) + (iy - curr_p.y).powi(2)).sqrt();
                if err < 8.0 {
                    corners[i] = Point2D { x: ix, y: iy };
                }
            }
        }
    }

    let mut edges_vec = Vec::with_capacity(4);

    let mut fwd_corner_span = 0usize;
    for e in 0..4 {
        let s = best_q_idx[e];
        let next_e = best_q_idx[(e + 1) % 4];
        fwd_corner_span += (next_e + n - s) % n;
    }
    let _is_forward_winding = fwd_corner_span < (n * 2);

    for e in 0..4 {
        let start_i = best_q_idx[e];
        let end_i = best_q_idx[(e + 1) % 4];

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
        let _std_dev = variance.sqrt();

        // Center signed distance to determine tab (outward) vs hole (inward)
        let mid_x = (p_start.x + p_end.x) * 0.5;
        let mid_y = (p_start.y + p_end.y) * 0.5;
        let center_dx = cx - mid_x;
        let center_dy = cy - mid_y;
        let _center_signed_dist = (center_dx * base_dy - center_dy * base_dx) / base_len;

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
            edge_type: EdgeType::Tab, // placeholder, resolved in Pass 2 below
            start_corner: p_start,
            end_corner: p_end,
            curvature_depth: max_signed_dist,
            curve_samples: samples,
            normalized_profile: norm_profile,
            fourier_descriptor: fourier,
        });
    }

    // Pass 2: Self-Referencing Relative Edge Classification (Option 1)
    // Real puzzle pieces cut by a die press have tabs/holes that protrude significantly further
    // than any natural cut curve. We rank the 4 edges by their combined protrusion score (rel_depth * 10 + std_dev).
    let mut scores: [(usize, f32); 4] = [
        (0, 0.0), (1, 0.0), (2, 0.0), (3, 0.0)
    ];

    for (i, edge) in edges_vec.iter().enumerate() {
        let b_dx = edge.end_corner.x - edge.start_corner.x;
        let b_dy = edge.end_corner.y - edge.start_corner.y;
        let b_len = (b_dx * b_dx + b_dy * b_dy).sqrt().max(1.0);
        let rel_d = edge.curvature_depth.abs() / b_len;

        let n = edge.curve_samples.len().max(1) as f32;
        let mut sum_d = 0.0f32;
        let mut sum_d2 = 0.0f32;
        for s in &edge.curve_samples {
            let d = ((s.x - edge.start_corner.x) * b_dy - (s.y - edge.start_corner.y) * b_dx) / b_len;
            sum_d += d;
            sum_d2 += d * d;
        }
        let mean = sum_d / n;
        let std_dev = (sum_d2 / n - mean * mean).max(0.0).sqrt();

        // Combined flatness metric: low = flat, high = tab or hole
        let s = rel_d * 10.0 + std_dev;
        scores[i] = (i, s);
    }

    scores.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    // Determine flat edges:
    // If a physical straight line cut was detected, the lowest scoring edge is a true Flat edge.
    // If NO straight line exists on the contour, the piece is an Interior piece unless
    // an edge has an unmistakably flat profile (s0 < 4.0).
    let has_straight_line = best_line.is_some();
    let mut is_flat = [false; 4];
    let s0 = scores[0].1;
    let s1 = scores[1].1;
    let s2 = scores[2].1;
    let s3 = scores[3].1;

    if has_straight_line {
        // True physical flat cut present
        if s0 < 8.8 && (s3 - s0 >= 1.8 || s0 < 4.0) {
            is_flat[scores[0].0] = true;
        }
        // Corner piece: second lowest edge is also a flat cut
        if is_flat[scores[0].0] && s1 < 8.8 && (s2 - s1 >= 1.2 || s1 < 4.0) {
            is_flat[scores[1].0] = true;
        }
    } else {
        // Pure interior piece: only classify as Flat if score is unconditionally flat
        if s0 < 4.0 {
            is_flat[scores[0].0] = true;
        }
    }

    for (i, edge) in edges_vec.iter_mut().enumerate() {
        if is_flat[i] {
            edge.edge_type = EdgeType::Flat;
        } else {
            let mid_x = (edge.start_corner.x + edge.end_corner.x) * 0.5;
            let mid_y = (edge.start_corner.y + edge.end_corner.y) * 0.5;
            let center_dx = cx - mid_x;
            let center_dy = cy - mid_y;
            let base_dx = edge.end_corner.x - edge.start_corner.x;
            let base_dy = edge.end_corner.y - edge.start_corner.y;
            let base_len = (base_dx * base_dx + base_dy * base_dy).sqrt().max(1.0);
            let center_signed_dist = (center_dx * base_dy - center_dy * base_dx) / base_len;

            if (edge.curvature_depth * center_signed_dist) > 0.0 {
                edge.edge_type = EdgeType::Hole;
            } else {
                edge.edge_type = EdgeType::Tab;
            }
        }
    }

    let flat_count = edges_vec.iter().filter(|e| e.edge_type == EdgeType::Flat).count();
    let is_corner = flat_count == 2;
    let is_border = flat_count == 1;

    let edges = [
        {
            let mut e0 = edges_vec[0].clone();
            e0.start_corner = corners[0];
            e0.end_corner = corners[1];
            if !e0.curve_samples.is_empty() {
                e0.curve_samples[0] = corners[0];
                let last = e0.curve_samples.len() - 1;
                e0.curve_samples[last] = corners[1];
            }
            e0
        },
        {
            let mut e1 = edges_vec[1].clone();
            e1.start_corner = corners[1];
            e1.end_corner = corners[2];
            if !e1.curve_samples.is_empty() {
                e1.curve_samples[0] = corners[1];
                let last = e1.curve_samples.len() - 1;
                e1.curve_samples[last] = corners[2];
            }
            e1
        },
        {
            let mut e2 = edges_vec[2].clone();
            e2.start_corner = corners[2];
            e2.end_corner = corners[3];
            if !e2.curve_samples.is_empty() {
                e2.curve_samples[0] = corners[2];
                let last = e2.curve_samples.len() - 1;
                e2.curve_samples[last] = corners[3];
            }
            e2
        },
        {
            let mut e3 = edges_vec[3].clone();
            e3.start_corner = corners[3];
            e3.end_corner = corners[0];
            if !e3.curve_samples.is_empty() {
                e3.curve_samples[0] = corners[3];
                let last = e3.curve_samples.len() - 1;
                e3.curve_samples[last] = corners[0];
            }
            e3
        },
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
