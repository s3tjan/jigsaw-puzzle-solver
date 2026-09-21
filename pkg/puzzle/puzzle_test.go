package puzzle_test

import (
	"jig/pkg/puzzle"
	"testing"
)

func TestGridCounts(t *testing.T) {
	grid := puzzle.Grid{Rows: 5, Cols: 5}
	if total := grid.TotalPieces(); total != 25 {
		t.Fatalf("expected 25 pieces, got %d", total)
	}
	if corners := grid.CornerCount(); corners != 4 {
		t.Fatalf("expected 4 corners, got %d", corners)
	}
	// 2*(5-2) + 2*(5-2) = 6 + 6 = 12
	if borders := grid.BorderCount(); borders != 12 {
		t.Fatalf("expected 12 border pieces, got %d", borders)
	}
	// 3 * 3 = 9
	if interiors := grid.InteriorCount(); interiors != 9 {
		t.Fatalf("expected 9 interior pieces, got %d", interiors)
	}
}

func TestPieceRotation(t *testing.T) {
	p := &puzzle.Piece{
		Edges: [4]puzzle.Edge{
			{Dir: puzzle.Top, Type: puzzle.Flat},
			{Dir: puzzle.Right, Type: puzzle.Tab},
			{Dir: puzzle.Bottom, Type: puzzle.Blank},
			{Dir: puzzle.Left, Type: puzzle.Flat},
		},
		Rotation: 0,
	}

	if p.Classification() != puzzle.ClassCorner {
		t.Fatalf("expected corner piece, got %s", p.Classification())
	}

	// Rotate 90 CW
	p.Rotate90CW()
	if p.Rotation != 90 {
		t.Fatalf("expected 90 deg rotation, got %d", p.Rotation)
	}
	// New Top should be old Left (Flat)
	if p.Edges[puzzle.Top].Type != puzzle.Flat {
		t.Errorf("expected Top to be Flat, got %v", p.Edges[puzzle.Top].Type)
	}
	// New Right should be old Top (Flat)
	if p.Edges[puzzle.Right].Type != puzzle.Flat {
		t.Errorf("expected Right to be Flat, got %v", p.Edges[puzzle.Right].Type)
	}
	// New Bottom should be old Right (Tab)
	if p.Edges[puzzle.Bottom].Type != puzzle.Tab {
		t.Errorf("expected Bottom to be Tab, got %v", p.Edges[puzzle.Bottom].Type)
	}
}
