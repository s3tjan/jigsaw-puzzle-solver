package curve

import (
	"jig/pkg/puzzle"
	"math"
)

// CubicBezier represents a 2D cubic Bézier curve defined by 4 control points: P0, P1, P2, P3.
type CubicBezier struct {
	P0 puzzle.Point2D
	P1 puzzle.Point2D
	P2 puzzle.Point2D
	P3 puzzle.Point2D
}

// PointAt evaluates the curve at parameter t in [0, 1].
// B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
func (cb CubicBezier) PointAt(t float64) puzzle.Point2D {
	u := 1.0 - t
	tt := t * t
	uu := u * u
	uuu := uu * u
	ttt := tt * t

	x := uuu*cb.P0.X + 3*uu*t*cb.P1.X + 3*u*tt*cb.P2.X + ttt*cb.P3.X
	y := uuu*cb.P0.Y + 3*uu*t*cb.P1.Y + 3*u*tt*cb.P2.Y + ttt*cb.P3.Y
	return puzzle.Point2D{X: x, Y: y}
}

// Sample points along the cubic bezier curve using N steps.
func (cb CubicBezier) Sample(samples int) []puzzle.Point2D {
	if samples < 2 {
		samples = 2
	}
	pts := make([]puzzle.Point2D, samples)
	for i := 0; i < samples; i++ {
		t := float64(i) / float64(samples-1)
		pts[i] = cb.PointAt(t)
	}
	return pts
}

// ArcLength approximates the length of the cubic curve.
func (cb CubicBezier) ArcLength(steps int) float64 {
	if steps < 10 {
		steps = 10
	}
	length := 0.0
	prev := cb.P0
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		curr := cb.PointAt(t)
		length += prev.DistanceTo(curr)
		prev = curr
	}
	return length
}

// CompositeCurve is a sequence of connected cubic Bézier segments.
type CompositeCurve struct {
	Segments []CubicBezier
}

// Sample uniform points across all connected segments.
func (cc CompositeCurve) Sample(samplesPerSegment int) []puzzle.Point2D {
	if len(cc.Segments) == 0 {
		return nil
	}
	var pts []puzzle.Point2D
	for i, seg := range cc.Segments {
		segPts := seg.Sample(samplesPerSegment)
		if i > 0 {
			segPts = segPts[1:] // Avoid duplicate joining points
		}
		pts = append(pts, segPts...)
	}
	return pts
}

// Reverse reverses the direction of a point sequence.
func Reverse(points []puzzle.Point2D) []puzzle.Point2D {
	n := len(points)
	rev := make([]puzzle.Point2D, n)
	for i := 0; i < n; i++ {
		rev[i] = points[n-1-i]
	}
	return rev
}

// Transform transforms points from standard normalized space [0,1] x [-0.5, 0.5]
// to the coordinate system between start point pStart and end point pEnd.
func Transform(points []puzzle.Point2D, pStart, pEnd puzzle.Point2D, flipNormal bool) []puzzle.Point2D {
	dx := pEnd.X - pStart.X
	dy := pEnd.Y - pStart.Y
	length := math.Hypot(dx, dy)
	if length == 0 {
		return points
	}

	// Unit tangent and normal vectors
	ux := dx / length
	uy := dy / length
	// Normal vector perpendicular to tangent
	nx := -uy
	ny := ux
	if flipNormal {
		nx = -nx
		ny = -ny
	}

	result := make([]puzzle.Point2D, len(points))
	for i, pt := range points {
		// pt.X is along the tangent (0 to 1)
		// pt.Y is along the normal
		rx := pStart.X + (pt.X*ux + pt.Y*nx)*length
		ry := pStart.Y + (pt.X*uy + pt.Y*ny)*length
		result[i] = puzzle.Point2D{X: rx, Y: ry}
	}
	return result
}
