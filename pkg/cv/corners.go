package cv

import (
	"errors"
	"jig/pkg/puzzle"
	"math"
	"sort"
)

// ComputeCentroid calculates center of mass (X, Y) of contour points.
func ComputeCentroid(pts []puzzle.Point2D) puzzle.Point2D {
	if len(pts) == 0 {
		return puzzle.Point2D{}
	}
	var sumX, sumY float64
	for _, p := range pts {
		sumX += p.X
		sumY += p.Y
	}
	n := float64(len(pts))
	return puzzle.Point2D{X: sumX / n, Y: sumY / n}
}

// DetectCorners finds the 4 true physical corners separating the 4 edges of a puzzle piece.
// Combines centroid distance with angular curvature to reliably separate corners from round tabs.
func DetectCorners(contour []puzzle.Point2D) ([4]int, error) {
	n := len(contour)
	if n < 30 {
		return [4]int{}, errors.New("contour has too few points for corner detection")
	}

	center := ComputeCentroid(contour)

	// In puzzle pieces, true corners have two key properties:
	// 1. High corner sharpness: angle between incoming and outgoing tangent vectors is ~90° (60° to 125°)
	// 2. High distance from centroid compared to adjacent boundary indentations
	k := n / 14
	if k < 4 {
		k = 4
	}

	type CornerScore struct {
		Index int
		Score float64
		Angle float64
		Dist  float64
	}
	var cands []CornerScore

	for i := 0; i < n; i++ {
		pPrev := contour[(i-k+n)%n]
		pCurr := contour[i]
		pNext := contour[(i+k)%n]

		v1 := puzzle.Point2D{X: pPrev.X - pCurr.X, Y: pPrev.Y - pCurr.Y}
		v2 := puzzle.Point2D{X: pNext.X - pCurr.X, Y: pNext.Y - pCurr.Y}

		l1 := math.Hypot(v1.X, v1.Y)
		l2 := math.Hypot(v2.X, v2.Y)
		if l1 == 0 || l2 == 0 {
			continue
		}

		dot := (v1.X*v2.X + v1.Y*v2.Y) / (l1 * l2)
		cross := v1.X*v2.Y - v1.Y*v2.X
		angleDeg := math.Acos(math.Max(-1.0, math.Min(1.0, dot))) * 180.0 / math.Pi

		// Convex turn (cross > 0) with angle near 90°
		if angleDeg >= 55.0 && angleDeg <= 135.0 && cross > 0 {
			dist := pCurr.DistanceTo(center)
			// Score favors angles closest to 90° and points further from center (corners are extremities)
			angleDiff := math.Abs(angleDeg - 90.0)
			score := dist / (1.0 + angleDiff*0.05)
			cands = append(cands, CornerScore{
				Index: i,
				Score: score,
				Angle: angleDeg,
				Dist:  dist,
			})
		}
	}

	// If curvature didn't yield enough candidates, fallback to centroid distance maxima
	if len(cands) < 4 {
		step := n / 4
		return [4]int{0, step, 2 * step, 3 * step}, nil
	}

	// Cluster nearby candidates (within k points of each other)
	sort.Slice(cands, func(i, j int) bool {
		return cands[i].Score > cands[j].Score
	})

	var clustered []CornerScore
	minSeparation := n / 10

	for _, c := range cands {
		tooClose := false
		for _, existing := range clustered {
			diff := math.Abs(float64(c.Index - existing.Index))
			if diff > float64(n)/2 {
				diff = float64(n) - diff
			}
			if diff < float64(minSeparation) {
				tooClose = true
				break
			}
		}
		if !tooClose {
			clustered = append(clustered, c)
		}
	}

	if len(clustered) < 4 {
		step := n / 4
		return [4]int{0, step, 2 * step, 3 * step}, nil
	}

	// Pick 4 corners that form the most balanced quadrilateral (approx ~quarter-perimeter steps)
	bestQuad := [4]int{clustered[0].Index, clustered[1].Index, clustered[2].Index, clustered[3].Index}
	bestCost := math.MaxFloat64

	numTest := len(clustered)
	if numTest > 8 {
		numTest = 8
	}

	for i0 := 0; i0 < numTest; i0++ {
		for i1 := i0 + 1; i1 < numTest; i1++ {
			for i2 := i1 + 1; i2 < numTest; i2++ {
				for i3 := i2 + 1; i3 < numTest; i3++ {
					quad := []int{clustered[i0].Index, clustered[i1].Index, clustered[i2].Index, clustered[i3].Index}
					sort.Ints(quad)

					// Desired step is n/4
					idealStep := float64(n) / 4.0
					cost := 0.0
					for s := 0; s < 4; s++ {
						step := float64((quad[(s+1)%4] - quad[s] + n) % n)
						cost += math.Pow(step-idealStep, 2)
					}

					if cost < bestCost {
						bestCost = cost
						bestQuad = [4]int{quad[0], quad[1], quad[2], quad[3]}
					}
				}
			}
		}
	}

	sort.Ints(bestQuad[:])
	return bestQuad, nil
}

// SplitContourIntoEdges partitions the closed contour into 4 sequential edges using the 4 corner indices.
func SplitContourIntoEdges(contour []puzzle.Point2D, corners [4]int) [4][]puzzle.Point2D {
	n := len(contour)
	var edges [4][]puzzle.Point2D

	for i := 0; i < 4; i++ {
		startIdx := corners[i]
		endIdx := corners[(i+1)%4]

		var edgePts []puzzle.Point2D
		if endIdx >= startIdx {
			edgePts = make([]puzzle.Point2D, endIdx-startIdx+1)
			copy(edgePts, contour[startIdx:endIdx+1])
		} else {
			edgePts = append(edgePts, contour[startIdx:n]...)
			edgePts = append(edgePts, contour[0:endIdx+1]...)
		}
		edges[i] = edgePts
	}

	return edges
}

// ClassifyEdgeShape determines if an edge is Flat, Tab (convex), or Blank (concave).
func ClassifyEdgeShape(edgePts []puzzle.Point2D) puzzle.EdgeType {
	n := len(edgePts)
	if n < 3 {
		return puzzle.Flat
	}

	pStart := edgePts[0]
	pEnd := edgePts[n-1]

	dx := pEnd.X - pStart.X
	dy := pEnd.Y - pStart.Y
	chordLen := math.Hypot(dx, dy)
	if chordLen == 0 {
		return puzzle.Flat
	}

	// Unit outward normal
	nx := dy / chordLen
	ny := -dx / chordLen

	maxDev := 0.0
	minDev := 0.0

	for _, p := range edgePts {
		vx := p.X - pStart.X
		vy := p.Y - pStart.Y
		proj := vx*nx + vy*ny
		if proj > maxDev {
			maxDev = proj
		}
		if proj < minDev {
			minDev = proj
		}
	}

	relMax := maxDev / chordLen
	relMin := minDev / chordLen

	// If protrusion outward is dominant -> Tab
	// If indentation inward is dominant -> Blank
	// Otherwise -> Flat
	if relMax > 0.12 && relMax > math.Abs(relMin) {
		return puzzle.Tab
	} else if math.Abs(relMin) > 0.12 && math.Abs(relMin) > relMax {
		return puzzle.Blank
	}
	return puzzle.Flat
}
