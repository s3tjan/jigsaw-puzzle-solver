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

// DetectCorners finds the 4 corner indices of a puzzle piece contour.
// In puzzle pieces, corners are local distance maxima relative to center of mass,
// spaced approximately ~90 degrees apart (quarter-perimeter steps).
func DetectCorners(contour []puzzle.Point2D) ([4]int, error) {
	n := len(contour)
	if n < 20 {
		return [4]int{}, errors.New("contour has too few points for corner detection")
	}

	center := ComputeCentroid(contour)

	// Compute Euclidean distance from centroid for each point
	dists := make([]float64, n)
	for i, p := range contour {
		dists[i] = p.DistanceTo(center)
	}

	// Smooth distances with moving average
	smoothedDists := make([]float64, n)
	w := 7
	for i := 0; i < n; i++ {
		sum := 0.0
		for j := -w; j <= w; j++ {
			idx := (i + j + n) % n
			sum += dists[idx]
		}
		smoothedDists[i] = sum / float64(2*w+1)
	}

	// Find local maxima with minimum prominence
	type Peak struct {
		Index int
		Dist  float64
	}
	var peaks []Peak
	minDistBetweenPeaks := n / 8 // At least 1/8th of perimeter apart

	for i := 0; i < n; i++ {
		prev := (i - 1 + n) % n
		next := (i + 1) % n
		if smoothedDists[i] >= smoothedDists[prev] && smoothedDists[i] >= smoothedDists[next] {
			// Check prominence over window
			isMax := true
			for j := -w; j <= w; j++ {
				idx := (i + j + n) % n
				if smoothedDists[idx] > smoothedDists[i] {
					isMax = false
					break
				}
			}
			if isMax {
				peaks = append(peaks, Peak{Index: i, Dist: smoothedDists[i]})
			}
		}
	}

	// If fewer than 4 peaks, sample 4 equidistant perimeter points starting at global max
	if len(peaks) < 4 {
		maxIdx := 0
		maxD := 0.0
		for i, d := range smoothedDists {
			if d > maxD {
				maxD = d
				maxIdx = i
			}
		}
		step := n / 4
		return [4]int{
			maxIdx,
			(maxIdx + step) % n,
			(maxIdx + 2*step) % n,
			(maxIdx + 3*step) % n,
		}, nil
	}

	// Sort peaks by distance descending and select 4 best separated by ~quarter perimeter
	sort.Slice(peaks, func(i, j int) bool {
		return peaks[i].Dist > peaks[j].Dist
	})

	// Best 4 peaks optimization: find 4 peaks that maximize perimeter separation (~n/4 apart)
	var selected [4]int
	selected[0] = peaks[0].Index

	for k := 1; k < 4; k++ {
		bestIdx := -1
		bestScore := -1.0
		targetIdx := (selected[0] + k*n/4) % n

		for _, p := range peaks {
			// Circular distance to target index
			circDiff := math.Abs(float64(p.Index - targetIdx))
			if circDiff > float64(n)/2 {
				circDiff = float64(n) - circDiff
			}
			score := p.Dist / (1.0 + circDiff*0.1)
			if score > bestScore {
				// Also verify separation from already selected corners
				tooClose := false
				for s := 0; s < k; s++ {
					diff := math.Abs(float64(p.Index - selected[s]))
					if diff > float64(n)/2 {
						diff = float64(n) - diff
					}
					if diff < float64(minDistBetweenPeaks) {
						tooClose = true
						break
					}
				}
				if !tooClose {
					bestScore = score
					bestIdx = p.Index
				}
			}
		}

		if bestIdx == -1 {
			selected[k] = (selected[0] + k*n/4) % n
		} else {
			selected[k] = bestIdx
		}
	}

	// Sort selected corner indices in ascending clockwise perimeter order
	sort.Ints(selected[:])
	return selected, nil
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
			// Wraps around boundary end
			edgePts = append(edgePts, contour[startIdx:n]...)
			edgePts = append(edgePts, contour[0:endIdx+1]...)
		}
		edges[i] = edgePts
	}

	return edges
}

// ClassifyEdgeShape determines if an edge is Flat, Tab (convex), or Blank (concave).
// Measures maximum deviation from the chord line connecting the two corner endpoints.
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

	// Unit normal vector pointing outwards (to the right of tangent vector)
	// Tangent is (dx/len, dy/len). Clockwise outer normal is (dy/len, -dx/len).
	nx := dy / chordLen
	ny := -dx / chordLen

	maxDeviation := 0.0
	for _, p := range edgePts {
		// Vector from start to point
		vx := p.X - pStart.X
		vy := p.Y - pStart.Y
		// Project onto outward normal
		proj := vx*nx + vy*ny
		if math.Abs(proj) > math.Abs(maxDeviation) {
			maxDeviation = proj
		}
	}

	relDeviation := maxDeviation / chordLen

	// Thresholds:
	// Flat: relative deviation < 0.08
	// Tab: positive protrusion outward > 0.08
	// Blank: negative indentation inward < -0.08
	if math.Abs(relDeviation) < 0.08 {
		return puzzle.Flat
	} else if relDeviation > 0 {
		return puzzle.Tab
	} else {
		return puzzle.Blank
	}
}
