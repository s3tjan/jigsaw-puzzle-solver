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

// DetectFlatSpans searches the closed contour for long straight spans indicating a border or frame edge.
type FlatSpan struct {
	StartIdx int
	EndIdx   int
	Chord    float64
	MaxDev   float64
}

func DetectFlatSpans(contour []puzzle.Point2D) []FlatSpan {
	n := len(contour)
	var spans []FlatSpan

	for l := 22; l <= 45; l++ {
		for i := 0; i < n; i++ {
			pStart := contour[i]
			pEnd := contour[(i+l)%n]
			chord := pStart.DistanceTo(pEnd)
			if chord < 90.0 {
				continue
			}

			nx := (pEnd.Y - pStart.Y) / chord
			ny := -(pEnd.X - pStart.X) / chord

			maxDev := 0.0
			for s := 0; s <= l; s++ {
				p := contour[(i+s)%n]
				vx := p.X - pStart.X
				vy := p.Y - pStart.Y
				dev := math.Abs(vx*nx + vy*ny)
				if dev > maxDev {
					maxDev = dev
				}
			}

			if maxDev/chord < 0.055 {
				spans = append(spans, FlatSpan{i, (i + l) % n, chord, maxDev})
			}
		}
	}
	return spans
}

// DetectCorners finds the 4 true physical corners separating the 4 edges of a puzzle piece.
// If the piece has a straight flat border edge, it prioritizes the two ends of the flat edge as corners.
func DetectCorners(contour []puzzle.Point2D) ([4]int, error) {
	n := len(contour)
	if n < 30 {
		return [4]int{}, errors.New("contour has too few points for corner detection")
	}

	center := ComputeCentroid(contour)

	// 1. Check for prominent straight flat edge(s) indicating border pieces
	flatSpans := DetectFlatSpans(contour)
	if len(flatSpans) > 0 {
		sort.Slice(flatSpans, func(i, j int) bool {
			return flatSpans[i].Chord > flatSpans[j].Chord
		})

		bestSpan := flatSpans[0]
		c0 := bestSpan.StartIdx
		c1 := bestSpan.EndIdx

		// Find the remaining 2 corners on the opposite half of the contour
		k := 5
		type Peak struct {
			idx   int
			score float64
		}
		var otherPeaks []Peak

		for i := 0; i < n; i++ {
			d0 := math.Min(math.Abs(float64(i-c0)), float64(n)-math.Abs(float64(i-c0)))
			d1 := math.Min(math.Abs(float64(i-c1)), float64(n)-math.Abs(float64(i-c1)))
			if d0 < 15 || d1 < 15 {
				continue
			}

			pPrev := contour[(i-k+n)%n]
			pCurr := contour[i]
			pNext := contour[(i+k)%n]

			inX, inY := pCurr.X-pPrev.X, pCurr.Y-pPrev.Y
			outX, outY := pNext.X-pCurr.X, pNext.Y-pCurr.Y
			lIn := math.Hypot(inX, inY)
			lOut := math.Hypot(outX, outY)
			if lIn == 0 || lOut == 0 {
				continue
			}

			dot := (inX*outX + inY*outY) / (lIn * lOut)
			cross := inX*outY - inY*outX
			angle := math.Acos(math.Max(-1.0, math.Min(1.0, dot))) * 180.0 / math.Pi

			if cross > 0 && angle >= 55.0 && angle <= 135.0 {
				dist := pCurr.DistanceTo(center)
				score := dist / (1.0 + math.Abs(angle-90.0)*0.03)
				otherPeaks = append(otherPeaks, Peak{i, score})
			}
		}

		sort.Slice(otherPeaks, func(i, j int) bool {
			return otherPeaks[i].score > otherPeaks[j].score
		})

		var clustered []Peak
		for _, p := range otherPeaks {
			tooClose := false
			for _, cl := range clustered {
				diff := math.Min(math.Abs(float64(p.idx-cl.idx)), float64(n)-math.Abs(float64(p.idx-cl.idx)))
				if diff < 15 {
					tooClose = true
					break
				}
			}
			if !tooClose {
				clustered = append(clustered, p)
			}
		}

		var bestC2, bestC3 int
		bestCost := math.MaxFloat64
		idealStep := float64(n) / 4.0

		for a := 0; a < len(clustered); a++ {
			for b := a + 1; b < len(clustered); b++ {
				candQuad := []int{c0, c1, clustered[a].idx, clustered[b].idx}
				sort.Ints(candQuad)

				cost := 0.0
				valid := true
				for s := 0; s < 4; s++ {
					step := float64((candQuad[(s+1)%4] - candQuad[s] + n) % n)
					if step < float64(n)*0.10 {
						valid = false
						break
					}
					cost += math.Pow(step-idealStep, 2)
				}
				if valid && cost < bestCost {
					bestCost = cost
					bestC2 = clustered[a].idx
					bestC3 = clustered[b].idx
				}
			}
		}

		if bestCost < math.MaxFloat64 {
			quad := [4]int{c0, c1, bestC2, bestC3}
			sort.Ints(quad[:])
			return quad, nil
		}

		c2 := (c1 + n/4) % n
		c3 := (c1 + n/2) % n
		if len(clustered) >= 2 {
			c2 = clustered[0].idx
			c3 = clustered[1].idx
		}

		quad := [4]int{c0, c1, c2, c3}
		sort.Ints(quad[:])
		return quad, nil
	}

	// 2. Interior piece corner detection using tangent turn curvature
	k := 5
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

		inX, inY := pCurr.X-pPrev.X, pCurr.Y-pPrev.Y
		outX, outY := pNext.X-pCurr.X, pNext.Y-pCurr.Y

		l1 := math.Hypot(inX, inY)
		l2 := math.Hypot(outX, outY)
		if l1 == 0 || l2 == 0 {
			continue
		}

		dot := (inX*outX + inY*outY) / (l1 * l2)
		cross := inX*outY - inY*outX
		angleDeg := math.Acos(math.Max(-1.0, math.Min(1.0, dot))) * 180.0 / math.Pi

		// Convex turn (cross > 0) with angle near 90°
		if angleDeg >= 55.0 && angleDeg <= 135.0 && cross > 0 {
			dist := pCurr.DistanceTo(center)
			angleDiff := math.Abs(angleDeg - 90.0)
			score := dist / (1.0 + angleDiff*0.04)
			cands = append(cands, CornerScore{
				Index: i,
				Score: score,
				Angle: angleDeg,
				Dist:  dist,
			})
		}
	}

	if len(cands) < 4 {
		step := n / 4
		return [4]int{0, step, 2 * step, 3 * step}, nil
	}

	sort.Slice(cands, func(i, j int) bool {
		return cands[i].Score > cands[j].Score
	})

	var clustered []CornerScore
	minSeparation := n / 12

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

	// Pick 4 corners that form the most balanced quadrilateral
	bestQuad := [4]int{clustered[0].Index, clustered[1].Index, clustered[2].Index, clustered[3].Index}
	bestCost := math.MaxFloat64

	numTest := len(clustered)
	if numTest > 10 {
		numTest = 10
	}

	for i0 := 0; i0 < numTest; i0++ {
		for i1 := i0 + 1; i1 < numTest; i1++ {
			for i2 := i1 + 1; i2 < numTest; i2++ {
				for i3 := i2 + 1; i3 < numTest; i3++ {
					quad := []int{clustered[i0].Index, clustered[i1].Index, clustered[i2].Index, clustered[i3].Index}
					sort.Ints(quad)

					idealStep := float64(n) / 4.0
					cost := 0.0
					for s := 0; s < 4; s++ {
						step := float64((quad[(s+1)%4] - quad[s] + n) % n)
						if step < float64(n)*0.12 {
							cost += 10000.0
						}
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

// EdgeTelemetry stores geometric curve analysis for a single physical edge.
type EdgeTelemetry struct {
	Type            puzzle.EdgeType  `json:"type"`
	ChordLength     float64          `json:"chord_length"`
	MaxProtrusion   float64          `json:"max_protrusion"`  // Positive outward peak (tab)
	MinIndentation  float64          `json:"min_indentation"` // Negative inward peak (blank)
	CurvatureRatio  float64          `json:"curvature_ratio"` // Max deviation / chord length
	OutwardNormal   puzzle.Point2D   `json:"outward_normal"`
	Midpoint        puzzle.Point2D   `json:"midpoint"`
	PeakPoint       puzzle.Point2D   `json:"peak_point"`
}

// ClassifyEdgeWithTelemetry extracts edge type alongside precise geometric curve telemetry.
func ClassifyEdgeWithTelemetry(edgePts []puzzle.Point2D) (puzzle.EdgeType, EdgeTelemetry) {
	n := len(edgePts)
	if n < 3 {
		return puzzle.Flat, EdgeTelemetry{Type: puzzle.Flat}
	}

	pStart := edgePts[0]
	pEnd := edgePts[n-1]

	dx := pEnd.X - pStart.X
	dy := pEnd.Y - pStart.Y
	chordLen := math.Hypot(dx, dy)
	if chordLen == 0 {
		return puzzle.Flat, EdgeTelemetry{Type: puzzle.Flat}
	}

	// Unit outward normal
	nx := dy / chordLen
	ny := -dx / chordLen

	maxDev := 0.0
	minDev := 0.0
	peakPt := edgePts[n/2]

	for _, p := range edgePts {
		vx := p.X - pStart.X
		vy := p.Y - pStart.Y
		proj := vx*nx + vy*ny
		if proj > maxDev {
			maxDev = proj
			peakPt = p
		}
		if proj < minDev {
			minDev = proj
			if math.Abs(proj) > maxDev {
				peakPt = p
			}
		}
	}

	relMax := maxDev / chordLen
	relMin := minDev / chordLen

	var edgeType puzzle.EdgeType
	ratio := 0.0
	if relMax > 0.12 && relMax > math.Abs(relMin) {
		edgeType = puzzle.Tab
		ratio = relMax
	} else if math.Abs(relMin) > 0.12 && math.Abs(relMin) > relMax {
		edgeType = puzzle.Blank
		ratio = math.Abs(relMin)
	} else {
		edgeType = puzzle.Flat
		ratio = math.Max(relMax, math.Abs(relMin))
	}

	telemetry := EdgeTelemetry{
		Type:           edgeType,
		ChordLength:    chordLen,
		MaxProtrusion:  maxDev,
		MinIndentation: math.Abs(minDev),
		CurvatureRatio: ratio,
		OutwardNormal:  puzzle.Point2D{X: nx, Y: ny},
		Midpoint:       puzzle.Point2D{X: (pStart.X + pEnd.X) / 2, Y: (pStart.Y + pEnd.Y) / 2},
		PeakPoint:      peakPt,
	}

	return edgeType, telemetry
}

// ClassifyEdgeShape determines if an edge is Flat, Tab (convex), or Blank (concave).
func ClassifyEdgeShape(edgePts []puzzle.Point2D) puzzle.EdgeType {
	t, _ := ClassifyEdgeWithTelemetry(edgePts)
	return t
}
