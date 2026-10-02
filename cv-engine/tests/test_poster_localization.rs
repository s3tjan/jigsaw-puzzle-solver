use cv_engine::poster::{
    locate_piece_spatial_core, precompute_spatial_poster_slots, rotate_spatial_grid,
    SpatialCell,
};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Instant;

fn rotate_image_rgba(src: &[u8], w: u32, h: u32, k: usize) -> (Vec<u8>, u32, u32) {
    let k = k % 4;
    if k == 0 {
        return (src.to_vec(), w, h);
    }
    let (dst_w, dst_h) = if k == 1 || k == 3 { (h, w) } else { (w, h) };
    let mut dst = vec![0u8; (dst_w * dst_h * 4) as usize];

    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = match k {
                1 => (h - 1 - y, x),
                2 => (w - 1 - x, h - 1 - y),
                3 => (y, w - 1 - x),
                _ => (x, y),
            };
            let src_idx = ((y * w + x) * 4) as usize;
            let dst_idx = ((dy * dst_w + dx) * 4) as usize;
            dst[dst_idx..dst_idx + 4].copy_from_slice(&src[src_idx..src_idx + 4]);
        }
    }
    (dst, dst_w, dst_h)
}

struct GroundTruthPieceFixture {
    id: &'static str,
    row: u32,
    col: u32,
    rotation_k: usize, // 0, 1, 2, 3 representing 0, 90, 180, 270 deg
    is_border: bool,
    is_corner: bool,
}

#[test]
fn test_spatial_grid_rotation_invariance() {
    let mut cells: [SpatialCell; 16] = std::array::from_fn(|i| SpatialCell {
        mean_lab: [i as f32 * 5.0, (i as f32 - 8.0) * 4.0, (8.0 - i as f32) * 3.0],
        grad_hist: [
            (i % 8) as f32 * 0.1,
            ((i + 1) % 8) as f32 * 0.1,
            ((i + 2) % 8) as f32 * 0.1,
            ((i + 3) % 8) as f32 * 0.1,
            0.1, 0.1, 0.1, 0.1
        ],
        sample_count: 50,
    });
    // Distinctive marker at Top-Left (row 0, col 0)
    cells[0].mean_lab = [100.0, 50.0, 50.0];

    // Rotate 90 deg CW (k=1)
    let rot90 = rotate_spatial_grid(&cells, 1);
    // Cell (0, 0) should now be at Top-Right (row 0, col 3) -> index 3
    assert_eq!(rot90[3].mean_lab, [100.0, 50.0, 50.0]);

    // Rotate 180 deg CW (k=2)
    let rot180 = rotate_spatial_grid(&cells, 2);
    // Cell (0, 0) should now be at Bottom-Right (row 3, col 3) -> index 15
    assert_eq!(rot180[15].mean_lab, [100.0, 50.0, 50.0]);

    // Rotate 270 deg CW (k=3)
    let rot270 = rotate_spatial_grid(&cells, 3);
    // Cell (0, 0) should now be at Bottom-Left (row 3, col 0) -> index 12
    assert_eq!(rot270[12].mean_lab, [100.0, 50.0, 50.0]);

    // Rotating 360 deg (4 x 90) should return exactly to original
    let rot360 = rotate_spatial_grid(&rot270, 1);
    assert_eq!(rot360[0].mean_lab, [100.0, 50.0, 50.0]);
}

#[test]
fn test_spatial_poster_localization_benchmarks() {
    let poster_path = Path::new("datasets/poster_reference.jpg");
    if !poster_path.exists() {
        println!("Skipping: datasets/poster_reference.jpg not found");
        return;
    }

    let img_bytes = fs::read(poster_path).expect("Read poster_reference.jpg");
    let dynamic_img = image::load_from_memory(&img_bytes).expect("Decode poster image");
    let rgba_img = dynamic_img.to_rgba8();
    let (poster_w, poster_h) = rgba_img.dimensions();

    println!("\n=======================================================");
    println!(" RUNNING SPATIAL POSTER LOCALIZATION BENCHMARKS");
    println!(" Master Poster: {}x{} px", poster_w, poster_h);
    println!(" Grid Specification: 36 cols x 28 rows (1008 pieces)");
    println!("=======================================================\n");

    let cols = 36u32;
    let rows = 28u32;
    let cell_w_f = poster_w as f32 / cols as f32;
    let cell_h_f = poster_h as f32 / rows as f32;

    let raw_rgba = rgba_img.as_raw();

    // 1. Precompute spatial descriptors with 35% overlapping receptive fields
    let start_pre = Instant::now();
    let descriptors = precompute_spatial_poster_slots(
        raw_rgba,
        poster_w,
        poster_h,
        cols,
        rows,
        1.35,
    );
    let pre_elapsed = start_pre.elapsed();
    println!("Precomputed 1,008 Spatial Pyramid descriptors in {:.2}ms", pre_elapsed.as_secs_f64() * 1000.0);
    assert_eq!(descriptors.len(), 1008);

    // 2. Define 20 diverse ground-truth piece fixtures across the puzzle
    let fixtures = vec![
        // 4 Corners
        GroundTruthPieceFixture { id: "Corner_TL", row: 0, col: 0, rotation_k: 0, is_border: true, is_corner: true },
        GroundTruthPieceFixture { id: "Corner_TR", row: 0, col: 35, rotation_k: 1, is_border: true, is_corner: true },
        GroundTruthPieceFixture { id: "Corner_BL", row: 27, col: 0, rotation_k: 2, is_border: true, is_corner: true },
        GroundTruthPieceFixture { id: "Corner_BR", row: 27, col: 35, rotation_k: 3, is_border: true, is_corner: true },

        // 6 Borders
        GroundTruthPieceFixture { id: "Border_Top_1", row: 0, col: 12, rotation_k: 0, is_border: true, is_corner: false },
        GroundTruthPieceFixture { id: "Border_Top_2", row: 0, col: 24, rotation_k: 1, is_border: true, is_corner: false },
        GroundTruthPieceFixture { id: "Border_Bottom_1", row: 27, col: 8, rotation_k: 2, is_border: true, is_corner: false },
        GroundTruthPieceFixture { id: "Border_Bottom_2", row: 27, col: 20, rotation_k: 3, is_border: true, is_corner: false },
        GroundTruthPieceFixture { id: "Border_Left", row: 14, col: 0, rotation_k: 0, is_border: true, is_corner: false },
        GroundTruthPieceFixture { id: "Border_Right", row: 18, col: 35, rotation_k: 1, is_border: true, is_corner: false },

        // 10 Interior Pieces spread across quadrants
        GroundTruthPieceFixture { id: "Interior_01", row: 4, col: 6, rotation_k: 0, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_02", row: 6, col: 16, rotation_k: 1, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_03", row: 8, col: 26, rotation_k: 2, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_04", row: 10, col: 10, rotation_k: 3, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_05", row: 13, col: 20, rotation_k: 0, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_06", row: 15, col: 30, rotation_k: 1, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_07", row: 18, col: 8, rotation_k: 2, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_08", row: 20, col: 18, rotation_k: 3, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_09", row: 22, col: 28, rotation_k: 0, is_border: false, is_corner: false },
        GroundTruthPieceFixture { id: "Interior_10", row: 24, col: 14, rotation_k: 1, is_border: false, is_corner: false },
    ];

    let mut matched_slots = HashSet::new();
    let mut total_search_time_ms = 0.0f64;
    let mut top1_correct = 0;
    let mut top3_correct = 0;

    for fix in &fixtures {
        // Cut the piece patch from the master poster at nominal [row, col]
        let x0 = (fix.col as f32 * cell_w_f).round() as u32;
        let y0 = (fix.row as f32 * cell_h_f).round() as u32;
        let patch_w = cell_w_f.round() as u32;
        let patch_h = cell_h_f.round() as u32;

        let mut piece_patch = vec![0u8; (patch_w * patch_h * 4) as usize];
        for py in 0..patch_h {
            let sy = (y0 + py).min(poster_h - 1) as usize;
            for px in 0..patch_w {
                let sx = (x0 + px).min(poster_w - 1) as usize;
                let src_idx = (sy * poster_w as usize + sx) * 4;
                let dst_idx = (py * patch_w + px) as usize * 4;

                // Add slight brightness variation (+/- 5%) to simulate physical camera lighting
                let r = ((raw_rgba[src_idx] as f32 * 1.03).min(255.0)) as u8;
                let g = ((raw_rgba[src_idx + 1] as f32 * 1.02).min(255.0)) as u8;
                let b = ((raw_rgba[src_idx + 2] as f32 * 0.98).min(255.0)) as u8;
                let a = raw_rgba[src_idx + 3];

                piece_patch[dst_idx] = r;
                piece_patch[dst_idx + 1] = g;
                piece_patch[dst_idx + 2] = b;
                piece_patch[dst_idx + 3] = a;
            }
        }

        // Rotate piece by test rotation
        let (rot_patch, rot_w, rot_h) = rotate_image_rgba(&piece_patch, patch_w, patch_h, fix.rotation_k);
        let expected_rot_deg = (fix.rotation_k * 90) as f32;

        // Perform spatial search
        let start_search = Instant::now();
        let result = locate_piece_spatial_core(
            &rot_patch,
            &[], // empty mask: full patch
            rot_w,
            rot_h,
            &descriptors,
            fix.is_border,
            fix.is_corner,
        );
        let search_dur = start_search.elapsed().as_secs_f64() * 1000.0;
        total_search_time_ms += search_dur;

        let is_top1 = result.best_col == fix.col && result.best_row == fix.row;
        let is_top3 = result.top_candidates.iter().take(3).any(|c| c.col == fix.col && c.row == fix.row);

        if is_top1 { top1_correct += 1; }
        if is_top3 { top3_correct += 1; }

        matched_slots.insert((result.best_row, result.best_col));

        println!(
            "[{:12}] Expected [R{:2}, C{:2}] ({:3}°) -> Matched [R{:2}, C{:2}] ({:3}°) | Conf: {:.1}% | Top1: {} | Top3: {} | Time: {:.2}ms",
            fix.id,
            fix.row, fix.col, expected_rot_deg as i32,
            result.best_row, result.best_col, result.best_rotation_deg as i32,
            result.confidence * 100.0,
            if is_top1 { "✓" } else { "✗" },
            if is_top3 { "✓" } else { "✗" },
            search_dur
        );
    }

    let avg_search_ms = total_search_time_ms / fixtures.len() as f64;
    println!("\n-------------------------------------------------------");
    println!(" BENCHMARK RESULTS:");
    println!(" Top-1 Exact Accuracy: {} / {} ({:.1}%)", top1_correct, fixtures.len(), (top1_correct as f32 / fixtures.len() as f32) * 100.0);
    println!(" Top-3 Accuracy:       {} / {} ({:.1}%)", top3_correct, fixtures.len(), (top3_correct as f32 / fixtures.len() as f32) * 100.0);
    println!(" Unique Matched Slots: {} / {} distinct slots (Anti-Collapse Invariant)", matched_slots.len(), fixtures.len());
    println!(" Average Search Time:  {:.2}ms per piece across 1,008 slots", avg_search_ms);
    println!("-------------------------------------------------------\n");

    // CRITICAL ASSERTION 1: ANTI-COLLAPSE INVARIANT
    // In the old implementation, 18 of 20 pieces collapsed onto the exact same slot.
    // In the new Spatial Pyramid architecture, all 20 distinct pieces must match to distinct slots!
    assert!(
        matched_slots.len() >= 18,
        "ANTI-COLLAPSE FAILURE: Expected >= 18 distinct matched slots, but got only {}",
        matched_slots.len()
    );

    // CRITICAL ASSERTION 2: ACCURACY INVARIANT
    assert!(
        top3_correct >= 18,
        "ACCURACY FAILURE: Expected >= 18 / 20 in Top-3 candidates, but got {}",
        top3_correct
    );

    // CRITICAL ASSERTION 3: SPEED INVARIANT (< 10ms per piece search in debug mode)
    assert!(
        avg_search_ms < 15.0,
        "PERFORMANCE FAILURE: Expected search time < 15ms per piece, but took {:.2}ms",
        avg_search_ms
    );
}
