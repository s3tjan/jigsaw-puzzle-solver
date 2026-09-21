package puzzle

import (
	"fmt"
	"image/color"
	"math"
)

// Direction represents the 4 sides of a piece.
type Direction int

const (
	Top Direction = iota
	Right
	Bottom
	Left
)

func (d Direction) String() string {
	switch d {
	case Top:
		return "Top"
	case Right:
		return "Right"
	case Bottom:
		return "Bottom"
	case Left:
		return "Left"
	default:
		return fmt.Sprintf("Unknown(%d)", d)
	}
}

// Opposite returns the opposing direction (e.g. Top <-> Bottom).
func (d Direction) Opposite() Direction {
	return (d + 2) % 4
}

// EdgeType represents the shape category of an edge.
type EdgeType int

const (
	Flat  EdgeType = 0  // Puzzle border
	Tab   EdgeType = 1  // Male connector (convex protrusion)
	Blank EdgeType = -1 // Female connector (concave pocket)
)

func (e EdgeType) String() string {
	switch e {
	case Flat:
		return "Flat"
	case Tab:
		return "Tab"
	case Blank:
		return "Blank"
	default:
		return fmt.Sprintf("EdgeType(%d)", e)
	}
}

// Point2D is a 2D float point.
type Point2D struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// DistanceTo returns Euclidean distance to another point.
func (p Point2D) DistanceTo(other Point2D) float64 {
	dx := p.X - other.X
	dy := p.Y - other.Y
	return math.Sqrt(dx*dx + dy*dy)
}

// Edge represents one side of a puzzle piece.
type Edge struct {
	Dir    Direction    `json:"direction"`
	Type   EdgeType     `json:"type"`
	Points []Point2D    `json:"points"` // Sampled points tracing the edge from corner A to corner B
	Colors []color.RGBA `json:"-"`      // Sampled RGB colors along the piece edge boundary
}

// IsComplementary returns true if two edge types can physically connect.
func (e Edge) IsComplementary(other Edge) bool {
	if e.Type == Flat || other.Type == Flat {
		return false
	}
	return (e.Type == Tab && other.Type == Blank) || (e.Type == Blank && other.Type == Tab)
}

// Rectangle defines float min and max points for bounding boxes.
type Rectangle struct {
	Min Point2D `json:"min"`
	Max Point2D `json:"max"`
}
