package matcher

import (
	"jig/pkg/puzzle"
	"math"
)

// IncompatibleDistance is returned when edges cannot physically connect.
const IncompatibleDistance = 1e9

// NormalizeToCanonical transforms a sequence of points so that:
// - The first point is at (0, 0)
// - The last point is at (1, 0)
// Points in between are rotated and scaled accordingly.
func NormalizeToCanonical(pts []puzzle.Point2D) []puzzle.Point2D {
	n := len(pts)
	if n < 2 {
		return pts
	}
	p0 := pts[0]
	pn := pts[n-1]

	dx := pn.X - p0.X
	dy := pn.Y - p0.Y
	length := math.Hypot(dx, dy)
	if length == 0 {
		return pts
	}

	// Cosine and sine of rotation angle
	cosA := dx / length
	sinA := dy / length

	canonical := make([]puzzle.Point2D, n)
	for i, p := range pts {
		tx := p.X - p0.X
		ty := p.Y - p0.Y
		rx := tx*cosA + ty*sinA
		ry := -tx*sinA + ty*cosA
		canonical[i] = puzzle.Point2D{
			X: rx / length,
			Y: ry / length,
		}
	}
	return canonical
}

// DistancePointToSegment returns the distance from point P to line segment AB.
func DistancePointToSegment(p, a, b puzzle.Point2D) float64 {
	dx := b.X - a.X
	dy := b.Y - a.Y
	l2 := dx*dx + dy*dy
	if l2 == 0 {
		return p.DistanceTo(a)
	}
	// Project p onto segment ab
	t := ((p.X-a.X)*dx + (p.Y-a.Y)*dy) / l2
	if t < 0 {
		return p.DistanceTo(a)
	} else if t > 1 {
		return p.DistanceTo(b)
	}
	proj := puzzle.Point2D{
		X: a.X + t*dx,
		Y: a.Y + t*dy,
	}
	return p.DistanceTo(proj)
}

// PolylineDistance measures bidirectional average distance between two canonical curves.
func PolylineDistance(curveA, curveB []puzzle.Point2D) float64 {
	distAtoB := 0.0
	for _, p := range curveA {
		minD := math.MaxFloat64
		for i := 0; i < len(curveB)-1; i++ {
			d := DistancePointToSegment(p, curveB[i], curveB[i+1])
			if d < minD {
				minD = d
			}
		}
		distAtoB += minD
	}
	distAtoB /= float64(len(curveA))

	distBtoA := 0.0
	for _, p := range curveB {
		minD := math.MaxFloat64
		for i := 0; i < len(curveA)-1; i++ {
			d := DistancePointToSegment(p, curveA[i], curveA[i+1])
			if d < minD {
				minD = d
			}
		}
		distBtoA += minD
	}
	distBtoA /= float64(len(curveB))

	return (distAtoB + distBtoA) / 2.0
}

// CurveDistance computes the geometric shape error between two candidate mating edges.
// When edgeA and edgeB mate:
// - One is Tab and the other is Blank.
// - In physical space, edgeB runs along the exact same path as edgeA, but in opposite direction.
// - Therefore, if we invert edgeB's normal (y -> -y) in canonical space, it should overlay edgeA.
func CurveDistance(edgeA, edgeB puzzle.Edge) float64 {
	if !edgeA.IsComplementary(edgeB) {
		return IncompatibleDistance
	}
	if len(edgeA.Points) < 2 || len(edgeB.Points) < 2 {
		return IncompatibleDistance
	}

	canA := NormalizeToCanonical(edgeA.Points)
	canB := NormalizeToCanonical(edgeB.Points)

	// Since edgeB travels in opposite physical direction around piece B,
	// canB starts where canA ends.
	// We flip canB so that (x, y) -> (1-x, -y).
	// Then canB aligned will go from (0, 0) to (1, 0) with matching Y signs!
	canBAligned := make([]puzzle.Point2D, len(canB))
	nB := len(canB)
	for i, p := range canB {
		canBAligned[nB-1-i] = puzzle.Point2D{
			X: 1.0 - p.X,
			Y: -p.Y,
		}
	}

	return PolylineDistance(canA, canBAligned)
}
