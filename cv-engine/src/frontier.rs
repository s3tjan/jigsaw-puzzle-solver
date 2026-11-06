use serde::{Deserialize, Serialize};

pub const BOARD_ROWS: usize = 28;
pub const BOARD_COLS: usize = 36;
pub const TOTAL_SLOTS: usize = BOARD_ROWS * BOARD_COLS; // 1008
pub const BORDER_SLOTS_COUNT: usize = 124;
pub const INTERIOR_SLOTS_COUNT: usize = 884;

/// Discrete edge polarity representation for interlocking puzzle pieces.
/// Bitwise encodings:
/// Flat: 0b00 (0) - Outer perimeter boundary
/// Tab:  0b01 (1) - Male protruding tab
/// Hole: 0b10 (2) - Female indented blank
/// Any:  0b11 (3) - Unconstrained / open to unplaced space
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
#[repr(u8)]
pub enum EdgePolarity {
    Flat = 0b00,
    Tab = 0b01,
    Hole = 0b10,
    Any = 0b11,
}

impl From<crate::contour::EdgeType> for EdgePolarity {
    #[inline]
    fn from(t: crate::contour::EdgeType) -> Self {
        match t {
            crate::contour::EdgeType::Tab => EdgePolarity::Tab,
            crate::contour::EdgeType::Hole => EdgePolarity::Hole,
            crate::contour::EdgeType::Flat => EdgePolarity::Flat,
        }
    }
}

impl EdgePolarity {
    /// Returns the exact mechanical mating complement for this polarity.
    /// Flat mates with Flat (outer boundary).
    /// Tab mates with Hole.
    /// Hole mates with Tab.
    /// Any remains Any (unconstrained).
    #[inline(always)]
    pub fn complement(&self) -> Self {
        match self {
            EdgePolarity::Flat => EdgePolarity::Flat,
            EdgePolarity::Tab => EdgePolarity::Hole,
            EdgePolarity::Hole => EdgePolarity::Tab,
            EdgePolarity::Any => EdgePolarity::Any,
        }
    }

    /// Check if two polarities can mechanically mate.
    #[inline(always)]
    pub fn mates_with(&self, other: EdgePolarity) -> bool {
        if *self == EdgePolarity::Any || other == EdgePolarity::Any {
            return true;
        }
        match (*self, other) {
            (EdgePolarity::Flat, EdgePolarity::Flat) => true,
            (EdgePolarity::Tab, EdgePolarity::Hole) => true,
            (EdgePolarity::Hole, EdgePolarity::Tab) => true,
            _ => false,
        }
    }
}

/// Cardinal edge orientations in standard clockwise order:
/// 0: North, 1: East, 2: South, 3: West
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum CardinalDirection {
    North = 0,
    East = 1,
    South = 2,
    West = 3,
}

/// 4-cardinal required polarity constraints for an empty board slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotPolarityConstraint {
    pub north: EdgePolarity,
    pub east: EdgePolarity,
    pub south: EdgePolarity,
    pub west: EdgePolarity,
}

impl SlotPolarityConstraint {
    pub fn unconstrained() -> Self {
        Self {
            north: EdgePolarity::Any,
            east: EdgePolarity::Any,
            south: EdgePolarity::Any,
            west: EdgePolarity::Any,
        }
    }

    #[inline(always)]
    pub fn as_array(&self) -> [EdgePolarity; 4] {
        [self.north, self.east, self.south, self.west]
    }

    /// Count how many cardinal edges have fixed (non-Any) constraints.
    #[inline(always)]
    pub fn fixed_edge_count(&self) -> usize {
        let mut count = 0;
        if self.north != EdgePolarity::Any { count += 1; }
        if self.east != EdgePolarity::Any { count += 1; }
        if self.south != EdgePolarity::Any { count += 1; }
        if self.west != EdgePolarity::Any { count += 1; }
        count
    }
}

/// Represents a piece already placed onto a board slot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlacedPiece {
    pub piece_id: u32,
    /// Physical rotation applied to the piece: 0 (0°), 1 (90° CW), 2 (180°), 3 (270° CW)
    pub rotation: u8,
    /// Edge polarities in board-aligned world coordinates: [North, East, South, West]
    pub polarities: [EdgePolarity; 4],
    /// Tab width in millimeters for each of the 4 edges [North, East, South, West] (0.0 for Flat)
    pub tab_widths_mm: [f32; 4],
}

/// An active frontier slot (empty slot sharing at least one edge with a placed piece or puzzle frame).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrontierSlot {
    pub r: usize,
    pub c: usize,
    pub constraints: SlotPolarityConstraint,
    /// Tab width requirements in mm from neighboring placed pieces (0.0 if unknown/unplaced)
    pub expected_tab_widths_mm: [f32; 4],
    /// Number of placed direct cardinal neighbors (1..=4)
    pub placed_neighbor_count: usize,
    /// True if this slot is located on the puzzle perimeter (Rows 0, 27 or Cols 0, 35)
    pub is_border: bool,
    /// True if this slot is one of the 4 corners: (0,0), (0,35), (27,0), (27,35)
    pub is_corner: bool,
}

/// Represents the complete 36 × 28 board assembly matrix.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardState {
    pub rows: usize,
    pub cols: usize,
    /// Flattened row-major grid storing placed pieces (None = empty)
    pub grid: Vec<Option<PlacedPiece>>,
}

impl Default for BoardState {
    fn default() -> Self {
        Self::new(BOARD_ROWS, BOARD_COLS)
    }
}

impl BoardState {
    pub fn new(rows: usize, cols: usize) -> Self {
        Self {
            rows,
            cols,
            grid: vec![None; rows * cols],
        }
    }

    #[inline(always)]
    pub fn index(&self, r: usize, c: usize) -> usize {
        r * self.cols + c
    }

    #[inline(always)]
    pub fn is_in_bounds(&self, r: usize, c: usize) -> bool {
        r < self.rows && c < self.cols
    }

    #[inline(always)]
    pub fn get_slot(&self, r: usize, c: usize) -> Option<&PlacedPiece> {
        if !self.is_in_bounds(r, c) {
            return None;
        }
        self.grid[self.index(r, c)].as_ref()
    }

    #[inline(always)]
    pub fn is_occupied(&self, r: usize, c: usize) -> bool {
        self.get_slot(r, c).is_some()
    }

    /// Place a piece onto slot (r, c) with board-aligned world polarities.
    pub fn place_piece(
        &mut self,
        r: usize,
        c: usize,
        piece_id: u32,
        rotation: u8,
        polarities: [EdgePolarity; 4],
        tab_widths_mm: [f32; 4],
    ) -> Result<(), String> {
        if !self.is_in_bounds(r, c) {
            return Err(format!("Coordinates ({}, {}) out of board bounds ({}x{})", r, c, self.rows, self.cols));
        }
        let idx = self.index(r, c);
        if self.grid[idx].is_some() {
            return Err(format!("Slot ({}, {}) is already occupied", r, c));
        }

        self.grid[idx] = Some(PlacedPiece {
            piece_id,
            rotation: rotation % 4,
            polarities,
            tab_widths_mm,
        });

        Ok(())
    }

    /// Remove a placed piece from slot (r, c).
    pub fn remove_piece(&mut self, r: usize, c: usize) -> Option<PlacedPiece> {
        if !self.is_in_bounds(r, c) {
            return None;
        }
        let idx = self.index(r, c);
        self.grid[idx].take()
    }

    /// Count total placed pieces on the board.
    pub fn placed_count(&self) -> usize {
        self.grid.iter().filter(|s| s.is_some()).count()
    }

    /// Check if slot (r, c) is on the outer boundary or corner.
    #[inline(always)]
    pub fn classify_slot(&self, r: usize, c: usize) -> (bool, bool) {
        let is_top = r == 0;
        let is_bottom = r == self.rows.saturating_sub(1);
        let is_left = c == 0;
        let is_right = c == self.cols.saturating_sub(1);
        let is_border = is_top || is_bottom || is_left || is_right;
        let is_corner = (is_left || is_right) && (is_top || is_bottom);
        (is_border, is_corner)
    }

    /// Compute the exact polarity and metric tab width constraints for empty slot (r, c).
    pub fn compute_slot_constraints(&self, r: usize, c: usize) -> (SlotPolarityConstraint, [f32; 4], usize) {
        let mut constraint = SlotPolarityConstraint::unconstrained();
        let mut expected_widths = [0.0f32; 4];
        let mut placed_neighbor_count = 0;

        // 1. Physical Board Outer Frame Constraints
        if r == 0 {
            constraint.north = EdgePolarity::Flat;
        }
        if r + 1 == self.rows {
            constraint.south = EdgePolarity::Flat;
        }
        if c == 0 {
            constraint.west = EdgePolarity::Flat;
        }
        if c + 1 == self.cols {
            constraint.east = EdgePolarity::Flat;
        }

        // 2. Neighboring Placed Pieces Constraints
        // North Neighbor (r - 1, c) -> its South edge mates with this slot's North edge
        if r > 0 {
            if let Some(north_piece) = self.get_slot(r - 1, c) {
                constraint.north = north_piece.polarities[CardinalDirection::South as usize].complement();
                expected_widths[CardinalDirection::North as usize] = north_piece.tab_widths_mm[CardinalDirection::South as usize];
                placed_neighbor_count += 1;
            }
        }

        // East Neighbor (r, c + 1) -> its West edge mates with this slot's East edge
        if c + 1 < self.cols {
            if let Some(east_piece) = self.get_slot(r, c + 1) {
                constraint.east = east_piece.polarities[CardinalDirection::West as usize].complement();
                expected_widths[CardinalDirection::East as usize] = east_piece.tab_widths_mm[CardinalDirection::West as usize];
                placed_neighbor_count += 1;
            }
        }

        // South Neighbor (r + 1, c) -> its North edge mates with this slot's South edge
        if r + 1 < self.rows {
            if let Some(south_piece) = self.get_slot(r + 1, c) {
                constraint.south = south_piece.polarities[CardinalDirection::North as usize].complement();
                expected_widths[CardinalDirection::South as usize] = south_piece.tab_widths_mm[CardinalDirection::North as usize];
                placed_neighbor_count += 1;
            }
        }

        // West Neighbor (r, c - 1) -> its East edge mates with this slot's West edge
        if c > 0 {
            if let Some(west_piece) = self.get_slot(r, c - 1) {
                constraint.west = west_piece.polarities[CardinalDirection::East as usize].complement();
                expected_widths[CardinalDirection::West as usize] = west_piece.tab_widths_mm[CardinalDirection::East as usize];
                placed_neighbor_count += 1;
            }
        }

        (constraint, expected_widths, placed_neighbor_count)
    }

    /// Retrieve all active frontier slots on the board.
    /// An empty slot is considered part of the active frontier if:
    /// - It has at least 1 placed direct neighbor, OR
    /// - It is an empty border slot when any border pieces are placed.
    pub fn get_active_frontier(&self) -> Vec<FrontierSlot> {
        let mut frontier = Vec::new();

        for r in 0..self.rows {
            for c in 0..self.cols {
                if self.is_occupied(r, c) {
                    continue;
                }

                let (constraint, expected_widths, placed_neighbors) = self.compute_slot_constraints(r, c);
                let (is_border, is_corner) = self.classify_slot(r, c);

                // Slot is on the active frontier if it has at least one placed neighbor,
                // or if it's on the boundary and touches an anchor.
                if placed_neighbors > 0 {
                    frontier.push(FrontierSlot {
                        r,
                        c,
                        constraints: constraint,
                        expected_tab_widths_mm: expected_widths,
                        placed_neighbor_count: placed_neighbors,
                        is_border,
                        is_corner,
                    });
                }
            }
        }

        // Sort frontier slots: slots with more placed neighbors have higher constraint density
        // (lowest entropy) and should be solved first.
        frontier.sort_by(|a, b| {
            b.placed_neighbor_count.cmp(&a.placed_neighbor_count)
                .then_with(|| (b.constraints.fixed_edge_count()).cmp(&a.constraints.fixed_edge_count()))
                .then_with(|| a.r.cmp(&b.r))
                .then_with(|| a.c.cmp(&b.c))
        });

        frontier
    }
}

