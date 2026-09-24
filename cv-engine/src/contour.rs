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
    pub curve_samples: Vec<Point2D>, // Dense normalized contour points
}

/// Complete geometric profile of a scanned puzzle piece
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ScannedPiece {
    pub center: Point2D,
    pub bounding_width: f32,
    pub bounding_height: f32,
    pub perimeter_length: f32,
    pub corners: [Point2D; 4], // Top-Left, Top-Right, Bottom-Right, Bottom-Left of the piece core
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

/// Extracts the continuous boundary contour using radial-sweep Moore-Neighbor tracing
pub fn trace_piece_contour(
    binary: &[u8],
    width: u32,
    height: u32,
) -> Option<Vec<Point2D>> {
    let w = width as i32;
    let h = height as i32;

    // Margin search: Ignore extreme outer border (where the calibration mat background is)
    let margin_x = (width as f32 * 0.12) as i32;
    let margin_y = (height as f32 * 0.12) as i32;

    // Find first foreground pixel (piece)
    let mut start_pt: Option<(i32, i32)> = None;
    'outer: for y in margin_y..(h - margin_y) {
        for x in margin_x..(w - margin_x) {
            let idx = (y * w + x) as usize;
            if binary[idx] == 255 {
                // Verify it has at least one background neighbor
                let left_idx = (y * w + (x - 1)) as usize;
                if binary[left_idx] == 0 {
                    start_pt = Some((x, y));
                    break 'outer;
                }
            }
        }
    }

    let (sx, sy) = start_pt?;
    let mut contour = Vec::new();

    // 8-connected neighbor offsets (clockwise)
    let dx = [-1,  0,  1,  1,  1,  0, -1, -1];
    let dy = [-1, -1, -1,  0,  1,  1,  1,  0];

    let mut curr_x = sx;
    let mut curr_y = sy;
    let mut backtrack_dir = 0; // direction we entered from

    contour.push(Point2D { x: sx as f32, y: sy as f32 });

    let max_steps = (width * height) as usize;
    for _ in 0..max_steps {
        let mut next_found = false;
        let start_dir = (backtrack_dir + 5) % 8; // clockwise scan start

        for i in 0..8 {
            let dir = (start_dir + i) % 8;
            let nx = curr_x + dx[dir];
            let ny = curr_y + dy[dir];

            if nx >= 0 && nx < w && ny >= 0 && ny < h {
                let nidx = (ny * w + nx) as usize;
                if binary[nidx] == 255 {
                    curr_x = nx;
                    curr_y = ny;
                    backtrack_dir = dir;
                    contour.push(Point2D { x: nx as f32, y: ny as f32 });
                    next_found = true;
                    break;
                }
            }
        }

        if !next_found || (curr_x == sx && curr_y == sy) {
            break;
        }
    }

    if contour.len() > 60 {
        Some(contour)
    } else {
        None // Too small to be a valid piece
    }
}

/// Identifies the 4 primary corner points of the jigsaw piece using curvature extrema & Douglas-Peucker
pub fn partition_edges_and_classify(contour: &[Point2D]) -> Option<ScannedPiece> {
    if contour.len() < 80 {
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

    // Find the 4 quadrant extrema relative to centroid:
    // Top-Left (min x+y), Top-Right (max x - y), Bottom-Right (max x+y), Bottom-Left (min x - y)
    let mut idx_tl = 0;
    let mut idx_tr = 0;
    let mut idx_br = 0;
    let mut idx_bl = 0;

    let mut score_tl = f32::MAX;
    let mut score_tr = f32::MIN;
    let mut score_br = f32::MIN;
    let mut score_bl = f32::MAX;

    for (i, p) in contour.iter().enumerate() {
        let s_tl = (p.x - cx) + (p.y - cy);
        if s_tl < score_tl {
            score_tl = s_tl;
            idx_tl = i;
        }

        let s_tr = (p.x - cx) - (p.y - cy);
        if s_tr > score_tr {
            score_tr = s_tr;
            idx_tr = i;
        }

        let s_br = (p.x - cx) + (p.y - cy);
        if s_br > score_br {
            score_br = s_br;
            idx_br = i;
        }

        let s_bl = (p.x - cx) - (p.y - cy);
        if s_bl < score_bl {
            score_bl = s_bl;
            idx_bl = i;
        }
    }

    let ordered_indices = [idx_tl, idx_tr, idx_br, idx_bl];
    let corners = [
        contour[idx_tl],
        contour[idx_tr],
        contour[idx_br],
        contour[idx_bl],
    ];

    // Partition the continuous contour into 4 edge sequences:
    // Edge 0: Top (TL -> TR)
    // Edge 1: Right (TR -> BR)
    // Edge 2: Bottom (BR -> BL)
    // Edge 3: Left (BL -> TL)
    let mut edges_vec = Vec::with_capacity(4);

    for e in 0..4 {
        let start_i = ordered_indices[e];
        let end_i = ordered_indices[(e + 1) % 4];

        let mut samples = Vec::new();
        let mut curr = start_i;
        while curr != end_i {
            samples.push(contour[curr]);
            curr = (curr + 1) % n;
        }
        samples.push(contour[end_i]);

        // Evaluate curvature depth relative to the straight baseline connecting corners
        let p_start = contour[start_i];
        let p_end = contour[end_i];
        let base_dx = p_end.x - p_start.x;
        let base_dy = p_end.y - p_start.y;
        let base_len = (base_dx * base_dx + base_dy * base_dy).sqrt().max(1.0);

        let mut max_signed_dist: f32 = 0.0;
        for s in &samples {
            // Signed 2D cross-product distance
            let dist = ((s.x - p_start.x) * base_dy - (s.y - p_start.y) * base_dx) / base_len;
            if dist.abs() > max_signed_dist.abs() {
                max_signed_dist = dist;
            }
        }

        // Classification threshold: tabs/holes deviate by > 12% of baseline length
        let rel_depth = max_signed_dist / base_len;
        let edge_type = if rel_depth.abs() < 0.12 {
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

    Some(ScannedPiece {
        center: Point2D { x: cx, y: cy },
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
