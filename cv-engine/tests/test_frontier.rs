use cv_engine::frontier::*;
use cv_engine::query::*;
use cv_engine::WasmBoardState;

#[test]
fn test_frontier_polarity_generation() {
    let mut board = BoardState::new(BOARD_ROWS, BOARD_COLS);
    assert_eq!(board.placed_count(), 0);
    // On an empty board, the active frontier bootstraps with the 4 corners as initial anchor candidates
    let initial_frontier = board.get_active_frontier();
    assert_eq!(initial_frontier.len(), 4, "Empty board must recommend 4 corners as initial seeds");
    assert!(initial_frontier.iter().all(|s| s.is_corner));

    // 1. Initial Outer Frame Boundary Test:
    // Slot (0, 0) should have North=Flat, West=Flat, East=Any, South=Any.
    let (c_0_0, _, neighbors) = board.compute_slot_constraints(0, 0);
    assert_eq!(neighbors, 0);
    assert_eq!(c_0_0.north, EdgePolarity::Flat);
    assert_eq!(c_0_0.west, EdgePolarity::Flat);
    assert_eq!(c_0_0.east, EdgePolarity::Any);
    assert_eq!(c_0_0.south, EdgePolarity::Any);

    // Slot (27, 35) should have South=Flat, East=Flat, North=Any, West=Any.
    let (c_br, _, _) = board.compute_slot_constraints(27, 35);
    assert_eq!(c_br.south, EdgePolarity::Flat);
    assert_eq!(c_br.east, EdgePolarity::Flat);
    assert_eq!(c_br.north, EdgePolarity::Any);
    assert_eq!(c_br.west, EdgePolarity::Any);

    // 2. Anchor Top-Left Corner Piece (0, 0):
    // Polarities: North: Flat, East: Tab, South: Hole, West: Flat
    // Tab widths: East: 4.8mm, South: 5.1mm
    board
        .place_piece(
            0,
            0,
            1,
            0,
            [EdgePolarity::Flat, EdgePolarity::Tab, EdgePolarity::Hole, EdgePolarity::Flat],
            [0.0, 4.8, 5.1, 0.0],
        )
        .expect("Placing corner piece at (0, 0) should succeed");

    assert_eq!(board.placed_count(), 1);

    // 3. Inspect Active Frontier after (0, 0) is placed:
    let frontier = board.get_active_frontier();
    assert_eq!(frontier.len(), 2, "Placing (0,0) must create exactly 2 frontier slots: (0, 1) and (1, 0)");

    // Frontier slot (0, 1) East of (0, 0):
    let f_east = frontier.iter().find(|s| s.r == 0 && s.c == 1).expect("Slot (0, 1) should be in frontier");
    assert_eq!(f_east.constraints.north, EdgePolarity::Flat, "Top border outer edge must be Flat");
    assert_eq!(f_east.constraints.west, EdgePolarity::Hole, "West edge must complement East Tab of (0, 0)");
    assert_eq!(f_east.expected_tab_widths_mm[CardinalDirection::West as usize], 4.8);
    assert_eq!(f_east.constraints.east, EdgePolarity::Any);
    assert_eq!(f_east.constraints.south, EdgePolarity::Any);
    assert_eq!(f_east.placed_neighbor_count, 1);
    assert!(f_east.is_border);
    assert!(!f_east.is_corner);

    // Frontier slot (1, 0) South of (0, 0):
    let f_south = frontier.iter().find(|s| s.r == 1 && s.c == 0).expect("Slot (1, 0) should be in frontier");
    assert_eq!(f_south.constraints.west, EdgePolarity::Flat, "Left border outer edge must be Flat");
    assert_eq!(f_south.constraints.north, EdgePolarity::Tab, "North edge must complement South Hole of (0, 0)");
    assert_eq!(f_south.expected_tab_widths_mm[CardinalDirection::North as usize], 5.1);
    assert_eq!(f_south.constraints.east, EdgePolarity::Any);
    assert_eq!(f_south.constraints.south, EdgePolarity::Any);
    assert_eq!(f_south.placed_neighbor_count, 1);
    assert!(f_south.is_border);

    // 4. Multi-Neighbor Convergence Test:
    // Place piece at (1, 0)
    // Polarities: North: Tab, East: Tab, South: Hole, West: Flat
    board
        .place_piece(
            1,
            0,
            2,
            0,
            [EdgePolarity::Tab, EdgePolarity::Tab, EdgePolarity::Hole, EdgePolarity::Flat],
            [5.1, 4.9, 5.0, 0.0],
        )
        .expect("Placing border piece at (1, 0) should succeed");

    // Also place piece at (0, 1)
    // Polarities: North: Flat, East: Hole, South: Tab, West: Hole
    board
        .place_piece(
            0,
            1,
            3,
            0,
            [EdgePolarity::Flat, EdgePolarity::Hole, EdgePolarity::Tab, EdgePolarity::Hole],
            [0.0, 4.7, 4.6, 4.8],
        )
        .expect("Placing border piece at (0, 1) should succeed");

    // Now inspect interior slot (1, 1), which has TWO placed neighbors: (0, 1) North and (1, 0) West!
    let frontier2 = board.get_active_frontier();
    let f_1_1 = frontier2.iter().find(|s| s.r == 1 && s.c == 1).expect("Slot (1, 1) must be in frontier");

    assert_eq!(f_1_1.placed_neighbor_count, 2, "Slot (1, 1) must have 2 placed neighbors");
    assert_eq!(f_1_1.constraints.north, EdgePolarity::Hole, "North must complement South Tab of (0, 1)");
    assert_eq!(f_1_1.expected_tab_widths_mm[CardinalDirection::North as usize], 4.6);
    assert_eq!(f_1_1.constraints.west, EdgePolarity::Hole, "West must complement East Tab of (1, 0)");
    assert_eq!(f_1_1.expected_tab_widths_mm[CardinalDirection::West as usize], 4.9);
    assert_eq!(f_1_1.constraints.east, EdgePolarity::Any);
    assert_eq!(f_1_1.constraints.south, EdgePolarity::Any);
    assert!(!f_1_1.is_border);
    assert!(!f_1_1.is_corner);

    // Verify ordering: (1, 1) with 2 neighbors must rank ahead of slots with 1 neighbor
    assert_eq!(frontier2[0].r, 1);
    assert_eq!(frontier2[0].c, 1);
}

#[test]
fn test_wasm_board_state_interop() {
    let mut wasm_board = WasmBoardState::default_1008();
    assert_eq!(wasm_board.placed_count(), 0);

    // Place piece at (0, 0): Flat(0), Tab(1), Hole(2), Flat(0)
    let res = wasm_board.place_piece(0, 0, 101, 0, 0, 1, 2, 0, 0.0, 4.5, 5.0, 0.0);
    assert!(res.is_ok());
    assert_eq!(wasm_board.placed_count(), 1);

    // Fetch frontier JSON
    let json_str = wasm_board.get_active_frontier_json().expect("JSON serialization must succeed");
    let frontier: Vec<FrontierSlot> = serde_json::from_str(&json_str).expect("Must deserialize into FrontierSlot list");
    assert_eq!(frontier.len(), 2);

    // Get specific slot constraints
    let slot_json = wasm_board.get_slot_constraints_json(0, 1).expect("Must get slot constraint JSON");
    let slot: FrontierSlot = serde_json::from_str(&slot_json).expect("Must deserialize slot");
    assert_eq!(slot.r, 0);
    assert_eq!(slot.c, 1);
    assert_eq!(slot.constraints.west, EdgePolarity::Hole);
}

#[test]
fn test_bitmask_polarity_pruning() {
    // 1. Test Cardinal Rotation Logic
    // Piece scanned at 0° with: Top: Flat, Right: Tab, Bottom: Hole, Left: Flat
    let p_corner = [EdgePolarity::Flat, EdgePolarity::Tab, EdgePolarity::Hole, EdgePolarity::Flat];
    let w_corner = [0.0, 4.5, 5.0, 0.0];

    // Rotation 0 (0°): [Flat, Tab, Hole, Flat]
    assert_eq!(rotate_polarities(p_corner, 0), p_corner);
    assert_eq!(rotate_tab_widths(w_corner, 0), w_corner);

    // Rotation 1 (90° CW): Left becomes Top, Top becomes Right, Right becomes Bottom, Bottom becomes Left
    // [W, N, E, S] -> [Flat, Flat, Tab, Hole]
    let r1 = rotate_polarities(p_corner, 1);
    assert_eq!(r1, [EdgePolarity::Flat, EdgePolarity::Flat, EdgePolarity::Tab, EdgePolarity::Hole]);
    let rw1 = rotate_tab_widths(w_corner, 1);
    assert_eq!(rw1, [0.0, 0.0, 4.5, 5.0]);

    // Rotation 2 (180° CW): [S, W, N, E] -> [Hole, Flat, Flat, Tab]
    let r2 = rotate_polarities(p_corner, 2);
    assert_eq!(r2, [EdgePolarity::Hole, EdgePolarity::Flat, EdgePolarity::Flat, EdgePolarity::Tab]);

    // Rotation 3 (270° CW): [E, S, W, N] -> [Tab, Hole, Flat, Flat]
    let r3 = rotate_polarities(p_corner, 3);
    assert_eq!(r3, [EdgePolarity::Tab, EdgePolarity::Hole, EdgePolarity::Flat, EdgePolarity::Flat]);

    // 2. Corner Constraint Pruning at (0, 0):
    // Slot (0, 0) requires North: Flat, West: Flat, East: Any, South: Any
    let corner_constraint = SlotPolarityConstraint {
        north: EdgePolarity::Flat,
        east: EdgePolarity::Any,
        south: EdgePolarity::Any,
        west: EdgePolarity::Flat,
    };

    let corner_piece = CandidatePieceInput {
        piece_id: 1,
        intrinsic_polarities: p_corner,
        tab_widths_mm: w_corner,
        is_border: true,
        is_corner: true,
    };

    let corner_matches = find_piece_valid_rotations(&corner_piece, &corner_constraint);
    assert_eq!(
        corner_matches.len(),
        1,
        "A true corner piece must match exactly 1 unique rotation for (0, 0)"
    );
    assert_eq!(corner_matches[0].rotation, 0);

    // Interior piece (0 flat edges):
    let interior_piece = CandidatePieceInput {
        piece_id: 2,
        intrinsic_polarities: [EdgePolarity::Tab, EdgePolarity::Hole, EdgePolarity::Tab, EdgePolarity::Hole],
        tab_widths_mm: [4.6, 4.8, 4.7, 4.9],
        is_border: false,
        is_corner: false,
    };

    let interior_matches = find_piece_valid_rotations(&interior_piece, &corner_constraint);
    assert!(
        interior_matches.is_empty(),
        "Interior piece must be 100% rejected at corner slot (0, 0)"
    );

    // Border piece with only 1 flat edge:
    let border_piece = CandidatePieceInput {
        piece_id: 3,
        intrinsic_polarities: [EdgePolarity::Flat, EdgePolarity::Tab, EdgePolarity::Hole, EdgePolarity::Tab],
        tab_widths_mm: [0.0, 4.8, 5.0, 4.7],
        is_border: true,
        is_corner: false,
    };

    let border_matches = find_piece_valid_rotations(&border_piece, &corner_constraint);
    assert!(
        border_matches.is_empty(),
        "Border piece with 1 flat edge cannot satisfy 2-flat corner constraint"
    );

    // 3. Flanked Interior Slot Pruning (2-Neighbor Convergence):
    // Slot (1, 1) constrained by North: Hole, West: Tab, East: Any, South: Any
    let flanked_constraint = SlotPolarityConstraint {
        north: EdgePolarity::Hole,
        east: EdgePolarity::Any,
        south: EdgePolarity::Any,
        west: EdgePolarity::Tab,
    };

    // Synthesize a representative pool of 16 interior pieces
    let mut pool = Vec::new();
    let mut id = 100;
    for &n in &[EdgePolarity::Tab, EdgePolarity::Hole] {
        for &e in &[EdgePolarity::Tab, EdgePolarity::Hole] {
            for &s in &[EdgePolarity::Tab, EdgePolarity::Hole] {
                for &w in &[EdgePolarity::Tab, EdgePolarity::Hole] {
                    pool.push(CandidatePieceInput {
                        piece_id: id,
                        intrinsic_polarities: [n, e, s, w],
                        tab_widths_mm: [4.8, 4.8, 4.8, 4.8],
                        is_border: false,
                        is_corner: false,
                    });
                    id += 1;
                }
            }
        }
    }
    assert_eq!(pool.len(), 16);

    let pruned = prune_candidates_by_polarity(&pool, &flanked_constraint);
    // Across 16 pieces * 4 rotations = 64 configurations:
    // Exactly 1 out of 4 pairs (N=Hole, W=Tab) can match: 64 / 4 = 16 matches total across the pool.
    // At least 75% of candidate configurations are pruned!
    assert!(!pruned.is_empty());
    for m in &pruned {
        assert_eq!(m.world_polarities[0], EdgePolarity::Hole, "North edge must match constraint");
        assert_eq!(m.world_polarities[3], EdgePolarity::Tab, "West edge must match constraint");
    }

    // 4. Test WASM Bridge Batch Query Method
    let mut wasm_board = WasmBoardState::default_1008();
    // Anchor corner (0, 0)
    wasm_board
        .place_piece(0, 0, 1, 0, 0, 1, 2, 0, 0.0, 4.8, 5.1, 0.0)
        .expect("Place piece");

    // Slot (0, 1) requires West: Hole, North: Flat
    let candidates_json = serde_json::to_string(&vec![
        border_piece.clone(),
        corner_piece.clone(),
        interior_piece.clone(),
    ])
    .expect("Serialize candidates");

    let matches_json = wasm_board
        .query_slot_polarity_candidates_json(0, 1, &candidates_json)
        .expect("Query candidates");

    let matches: Vec<PolarityMatch> = serde_json::from_str(&matches_json).expect("Deserialize matches");
    // border_piece has 1 flat edge and can potentially match (0, 1) if rotated such that Flat is North and Hole is West
    for m in &matches {
        assert_eq!(m.world_polarities[0], EdgePolarity::Flat);
        assert_eq!(m.world_polarities[3], EdgePolarity::Hole);
    }

    // 5. Invariant Test: Border pieces must NEVER match interior slots, even with unconstrained Any edges
    let interior_constraint = SlotPolarityConstraint {
        north: EdgePolarity::Hole,
        east: EdgePolarity::Any,
        south: EdgePolarity::Any,
        west: EdgePolarity::Any,
    };
    let border_leak_test = find_piece_valid_rotations(&border_piece, &interior_constraint);
    assert!(
        border_leak_test.is_empty(),
        "Border piece with a flat edge must NEVER match an interior slot (0 required flat edges)"
    );

    // 6. Invariant Test: Already placed piece must be excluded from WASM candidate queries
    let already_placed_json = serde_json::to_string(&vec![
        CandidatePieceInput {
            piece_id: 1, // Piece 1 was already placed at (0, 0)
            intrinsic_polarities: p_corner,
            tab_widths_mm: w_corner,
            is_border: true,
            is_corner: true,
        }
    ]).unwrap();
    let query_res = wasm_board.query_slot_polarity_candidates_json(0, 1, &already_placed_json).unwrap();
    let placed_matches: Vec<PolarityMatch> = serde_json::from_str(&query_res).unwrap();
    assert!(
        placed_matches.is_empty(),
        "Pieces already placed on the board must not be suggested again"
    );
}

