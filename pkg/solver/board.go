package solver

import (
	"jig/pkg/puzzle"
)

// PlacedPiece represents a piece placed at a board coordinate.
type PlacedPiece struct {
	Piece    *puzzle.Piece
	Rotation int // 0, 90, 180, 270 degrees
}

// Board represents an R x C puzzle board state during assembly.
type Board struct {
	Grid   puzzle.Grid
	Cells  [][]*PlacedPiece // [row][col]
	Placed map[int]bool     // piece ID -> placed
}

// NewBoard initializes an empty board.
func NewBoard(grid puzzle.Grid) *Board {
	cells := make([][]*PlacedPiece, grid.Rows)
	for r := 0; r < grid.Rows; r++ {
		cells[r] = make([]*PlacedPiece, grid.Cols)
	}
	return &Board{
		Grid:   grid,
		Cells:  cells,
		Placed: make(map[int]bool),
	}
}

// IsPlaced checks if a piece has already been placed on the board.
func (b *Board) IsPlaced(pieceID int) bool {
	return b.Placed[pieceID]
}

// Place assigns a piece with its current rotation to cell (r, c).
func (b *Board) Place(r, c int, piece *puzzle.Piece) {
	b.Cells[r][c] = &PlacedPiece{
		Piece:    piece,
		Rotation: piece.Rotation,
	}
	b.Placed[piece.ID] = true
}

// Remove clears cell (r, c).
func (b *Board) Remove(r, c int) {
	if b.Cells[r][c] != nil {
		delete(b.Placed, b.Cells[r][c].Piece.ID)
		b.Cells[r][c] = nil
	}
}

// At returns the placed piece at (r, c) or nil.
func (b *Board) At(r, c int) *PlacedPiece {
	if r < 0 || r >= b.Grid.Rows || c < 0 || c >= b.Grid.Cols {
		return nil
	}
	return b.Cells[r][c]
}

// PlacedNeighborsCount returns the number of filled orthogonal neighbor cells around (r, c).
func (b *Board) PlacedNeighborsCount(r, c int) int {
	count := 0
	if r > 0 && b.Cells[r-1][c] != nil {
		count++
	}
	if r < b.Grid.Rows-1 && b.Cells[r+1][c] != nil {
		count++
	}
	if c > 0 && b.Cells[r][c-1] != nil {
		count++
	}
	if c < b.Grid.Cols-1 && b.Cells[r][c+1] != nil {
		count++
	}
	return count
}
