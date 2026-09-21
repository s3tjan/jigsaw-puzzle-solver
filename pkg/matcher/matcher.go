package matcher

import (
	"jig/pkg/puzzle"
	"math"
)

// MatchResult stores the compatibility evaluation between two piece edges.
type MatchResult struct {
	Score        float64 // Lower is better (0 = perfect match)
	GeomDistance float64
	ColorDist    float64
	Compatible   bool
}

// EdgeMatcher calculates pairwise edge compatibility scores.
type EdgeMatcher struct {
	GeomWeight  float64
	ColorWeight float64
}

// NewDefaultMatcher creates an EdgeMatcher with balanced default weights.
func NewDefaultMatcher() *EdgeMatcher {
	return &EdgeMatcher{
		GeomWeight:  1.0,
		ColorWeight: 1.5,
	}
}

// MatchEdges computes the match score between edgeA of piece A and edgeB of candidate piece B.
func (m *EdgeMatcher) MatchEdges(edgeA, edgeB puzzle.Edge) MatchResult {
	if !edgeA.IsComplementary(edgeB) {
		return MatchResult{
			Score:      math.MaxFloat64,
			Compatible: false,
		}
	}

	geomDist := CurveDistance(edgeA, edgeB)
	if geomDist >= IncompatibleDistance {
		return MatchResult{
			Score:      math.MaxFloat64,
			Compatible: false,
		}
	}

	colorDist := ColorDistance(edgeA, edgeB)

	// Combine geometry distance and color distance
	score := m.GeomWeight*geomDist + m.ColorWeight*colorDist

	return MatchResult{
		Score:        score,
		GeomDistance: geomDist,
		ColorDist:    colorDist,
		Compatible:   true,
	}
}
