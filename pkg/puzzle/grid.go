package puzzle

// Grid represents the puzzle dimensions and topology.
type Grid struct {
	Rows int `json:"rows"`
	Cols int `json:"cols"`
}

// TotalPieces returns Rows * Cols.
func (g Grid) TotalPieces() int {
	return g.Rows * g.Cols
}

// CornerCount returns the number of corners (always 4 for standard rectangular puzzles).
func (g Grid) CornerCount() int {
	if g.Rows <= 1 || g.Cols <= 1 {
		return g.TotalPieces()
	}
	return 4
}

// BorderCount returns the number of non-corner border pieces.
func (g Grid) BorderCount() int {
	if g.Rows <= 2 || g.Cols <= 2 {
		return 0
	}
	return 2*(g.Rows-2) + 2*(g.Cols-2)
}

// InteriorCount returns the count of interior pieces (0 flat edges).
func (g Grid) InteriorCount() int {
	if g.Rows <= 2 || g.Cols <= 2 {
		return 0
	}
	return (g.Rows - 2) * (g.Cols - 2)
}

// IsCorner returns true if the coordinate is one of the 4 grid corners.
func (g Grid) IsCorner(r, c int) bool {
	return (r == 0 || r == g.Rows-1) && (c == 0 || c == g.Cols-1)
}

// IsBorder returns true if the coordinate is on the boundary (including corners).
func (g Grid) IsBorder(r, c int) bool {
	return r == 0 || r == g.Rows-1 || c == 0 || c == g.Cols-1
}
