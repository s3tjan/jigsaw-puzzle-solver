package solver

import (
	"jig/pkg/matcher"
	"jig/pkg/puzzle"
	"sort"
	"sync"
)

// EdgeMatchCandidate holds a candidate piece edge and its match score.
type EdgeMatchCandidate struct {
	Piece     *puzzle.Piece
	Candidate *puzzle.Piece
	Score     float64
}

// BorderCompatibility holds candidate matching border pieces.
type BorderCompatibility struct {
	// For each piece ID, maps to candidates
	m *matcher.EdgeMatcher
}

// FindMatchingBorderPieces dynamically finds candidate border pieces whose edge connects to prevEdge.
func (bc *BorderCompatibility) FindMatchingBorderPieces(prevEdge puzzle.Edge, candidates []*puzzle.Piece, used map[int]bool, flatDir, backwardDir puzzle.Direction) []*puzzle.Piece {
	type scoredPiece struct {
		piece *puzzle.Piece
		score float64
	}

	var valid []scoredPiece
	for _, p := range candidates {
		if used[p.ID] {
			continue
		}

		// Save piece rotation before orienting
		origRot := p.Rotation

		// Orient so flat edge faces flatDir
		if !OrientBorder(p, flatDir) {
			// Restore rotation
			for p.Rotation != origRot {
				p.Rotate90CW()
			}
			continue
		}

		// Check if backwardDir meets prevEdge
		res := bc.m.MatchEdges(p.Edges[backwardDir], prevEdge)
		if res.Compatible && res.GeomDistance < 0.08 {
			valid = append(valid, scoredPiece{
				piece: p,
				score: res.Score,
			})
		} else {
			// Restore rotation if not compatible
			for p.Rotation != origRot {
				p.Rotate90CW()
			}
		}
	}

	sort.Slice(valid, func(i, j int) bool {
		return valid[i].score < valid[j].score
	})

	result := make([]*puzzle.Piece, len(valid))
	for i, sp := range valid {
		result[i] = sp.piece
	}
	return result
}

// Suppress unused imports
func suppressSync() {
	var _ sync.Mutex
}
