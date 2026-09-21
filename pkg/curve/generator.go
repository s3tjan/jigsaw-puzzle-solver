package curve

import (
	"jig/pkg/puzzle"
	"math/rand"
)

// JigsawProfileConfig tunes the appearance of the jigsaw tab.
type JigsawProfileConfig struct {
	NeckWidth  float64 // width of the neck (e.g. 0.20)
	HeadWidth  float64 // width of the head/ear (e.g. 0.35)
	HeadHeight float64 // protrusion height (e.g. 0.25)
	Jitter     float64 // random variation factor (e.g. 0.04)
}

// DefaultProfileConfig returns standard jigsaw interlocking parameters.
func DefaultProfileConfig() JigsawProfileConfig {
	return JigsawProfileConfig{
		NeckWidth:  0.20,
		HeadWidth:  0.36,
		HeadHeight: 0.25,
		Jitter:     0.03,
	}
}

// GenerateNormalizedTabProfile creates a 5-segment cubic Bézier tab curve in [0, 1] normalized coordinates.
// The base line is y=0 from x=0 to x=1. The tab protrudes towards positive y.
func GenerateNormalizedTabProfile(cfg JigsawProfileConfig, rng *rand.Rand) CompositeCurve {
	// Add slight organic asymmetry
	jX1 := (rng.Float64()*2 - 1) * cfg.Jitter
	jX2 := (rng.Float64()*2 - 1) * cfg.Jitter
	jY := (rng.Float64()*2 - 1) * cfg.Jitter

	midX := 0.5 + jX1
	neckW := cfg.NeckWidth
	headW := cfg.HeadWidth + jX2
	headH := cfg.HeadHeight + jY

	p0 := puzzle.Point2D{X: 0.0, Y: 0.0}
	pNeckLeft := puzzle.Point2D{X: midX - neckW/2, Y: 0.0}
	pHeadLeft := puzzle.Point2D{X: midX - headW/2, Y: headH * 0.7}
	pHeadTop := puzzle.Point2D{X: midX, Y: headH}
	pHeadRight := puzzle.Point2D{X: midX + headW/2, Y: headH * 0.7}
	pNeckRight := puzzle.Point2D{X: midX + neckW/2, Y: 0.0}
	pEnd := puzzle.Point2D{X: 1.0, Y: 0.0}

	// 5-segment spline
	// Segment 1: p0 to pNeckLeft (flat baseline start)
	seg1 := CubicBezier{
		P0: p0,
		P1: puzzle.Point2D{X: pNeckLeft.X * 0.4, Y: 0.0},
		P2: puzzle.Point2D{X: pNeckLeft.X * 0.8, Y: 0.0},
		P3: pNeckLeft,
	}

	// Segment 2: pNeckLeft up to pHeadLeft
	seg2 := CubicBezier{
		P0: pNeckLeft,
		P1: puzzle.Point2D{X: pNeckLeft.X - 0.05, Y: headH * 0.3},
		P2: puzzle.Point2D{X: pHeadLeft.X - 0.03, Y: headH * 0.5},
		P3: pHeadLeft,
	}

	// Segment 3: pHeadLeft around the top to pHeadRight
	seg3 := CubicBezier{
		P0: pHeadLeft,
		P1: puzzle.Point2D{X: pHeadLeft.X, Y: pHeadTop.Y + 0.05},
		P2: puzzle.Point2D{X: pHeadRight.X, Y: pHeadTop.Y + 0.05},
		P3: pHeadRight,
	}

	// Segment 4: pHeadRight down to pNeckRight
	seg4 := CubicBezier{
		P0: pHeadRight,
		P1: puzzle.Point2D{X: pHeadRight.X + 0.03, Y: headH * 0.5},
		P2: puzzle.Point2D{X: pNeckRight.X + 0.05, Y: headH * 0.3},
		P3: pNeckRight,
	}

	// Segment 5: pNeckRight to pEnd
	seg5 := CubicBezier{
		P0: pNeckRight,
		P1: puzzle.Point2D{X: pNeckRight.X + (1.0-pNeckRight.X)*0.2, Y: 0.0},
		P2: puzzle.Point2D{X: pNeckRight.X + (1.0-pNeckRight.X)*0.6, Y: 0.0},
		P3: pEnd,
	}

	return CompositeCurve{
		Segments: []CubicBezier{seg1, seg2, seg3, seg4, seg5},
	}
}

// GenerateStraightEdge returns a flat line edge sampled with N points.
func GenerateStraightEdge(pStart, pEnd puzzle.Point2D, samples int) []puzzle.Point2D {
	pts := make([]puzzle.Point2D, samples)
	for i := 0; i < samples; i++ {
		t := float64(i) / float64(samples-1)
		pts[i] = puzzle.Point2D{
			X: pStart.X + t*(pEnd.X-pStart.X),
			Y: pStart.Y + t*(pEnd.Y-pStart.Y),
		}
	}
	return pts
}
