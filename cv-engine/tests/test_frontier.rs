use cv_engine::frontier::*;
use cv_engine::WasmBoardState;

#[test]
fn test_frontier_polarity_generation() {
    let mut board = BoardState::new(BOARD_ROWS, BOARD_COLS);
    assert_eq!(board.placed_count(), 0);
    assert!(board.get_active_frontier().is_empty());

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

