package puzzle

import (
	"image"
)

// PieceClassification describes the role of a piece on the board.
type PieceClassification string

const (
	ClassCorner   PieceClassification = "corner"
	ClassBorder   PieceClassification = "border"
	ClassInterior PieceClassification = "interior"
)

// Piece represents a single puzzle piece.
type Piece struct {
	ID          int                 `json:"id"`
	OriginalRow int                 `json:"original_row"`
	OriginalCol int                 `json:"original_col"`
	Edges       [4]Edge             `json:"edges"` // Indexed by Direction: Top (0), Right (1), Bottom (2), Left (3)
	Rotation    int                 `json:"rotation"` // 0, 90, 180, 270 (degrees clockwise)
	Image       image.Image         `json:"-"`
	Mask        *image.Alpha        `json:"-"`
	Bounds      image.Rectangle     `json:"bounds"`
}

// Classification returns whether the piece is Corner, Border, or Interior.
func (p *Piece) Classification() PieceClassification {
	flatCount := 0
	for _, e := range p.Edges {
		if e.Type == Flat {
			flatCount++
		}
	}
	switch flatCount {
	case 2:
		return ClassCorner
	case 1:
		return ClassBorder
	default:
		return ClassInterior
	}
}

// FlatEdgeCount returns the number of flat edges on the piece.
func (p *Piece) FlatEdgeCount() int {
	c := 0
	for _, e := range p.Edges {
		if e.Type == Flat {
			c++
		}
	}
	return c
}

// Rotate90CW rotates the piece 90 degrees clockwise.
// Edges shift: new Top = old Left, new Right = old Top, etc.
func (p *Piece) Rotate90CW() {
	p.Rotation = (p.Rotation + 90) % 360
	oldEdges := p.Edges
	// Top (0) gets Left (3)
	p.Edges[Top] = oldEdges[Left]
	p.Edges[Top].Dir = Top

	// Right (1) gets Top (0)
	p.Edges[Right] = oldEdges[Top]
	p.Edges[Right].Dir = Right

	// Bottom (2) gets Right (1)
	p.Edges[Bottom] = oldEdges[Right]
	p.Edges[Bottom].Dir = Bottom

	// Left (3) gets Bottom (2)
	p.Edges[Left] = oldEdges[Bottom]
	p.Edges[Left].Dir = Left
}
