package solver

import (
	"errors"
	"jig/pkg/matcher"
	"jig/pkg/puzzle"
	"math"
	"math/rand"
	"sort"
)

// SolverConfig options for the solver.
type SolverConfig struct {
	MaxBacktracks int
	ColorWeight   float64
	GeomWeight    float64
}

// DefaultSolverConfig returns sensible defaults.
func DefaultSolverConfig() SolverConfig {
	return SolverConfig{
		MaxBacktracks: 10000,
		ColorWeight:   2.0,
		GeomWeight:    1.0,
	}
}

// Solver assembles pieces onto a board.
type Solver struct {
	grid    puzzle.Grid
	pieces  []*puzzle.Piece
	matcher *matcher.EdgeMatcher
	cfg     SolverConfig
}

// NewSolver creates a new jigsaw puzzle solver.
func NewSolver(grid puzzle.Grid, pieces []*puzzle.Piece, cfg SolverConfig) *Solver {
	m := matcher.NewDefaultMatcher()
	m.ColorWeight = cfg.ColorWeight
	m.GeomWeight = cfg.GeomWeight
	return &Solver{
		grid:    grid,
		pieces:  pieces,
		matcher: m,
		cfg:     cfg,
	}
}

// ShuffleAndRotate randomly permutes pieces and assigns each a random rotation (0, 90, 180, 270).
func ShuffleAndRotate(pieces []*puzzle.Piece, rng *rand.Rand) {
	rng.Shuffle(len(pieces), func(i, j int) {
		pieces[i], pieces[j] = pieces[j], pieces[i]
	})

	for _, p := range pieces {
		rotSteps := rng.Intn(4)
		for s := 0; s < rotSteps; s++ {
			p.Rotate90CW()
		}
	}
}

// SolveResult holds the assembly outcome.
type SolveResult struct {
	Board           *Board
	Accuracy        float64
	GlobalRotation  int
	TotalPlacements int
}

// EvaluateSlotPieceScore evaluates how well candidate piece P (in its current rotation)
// fits into cell (r, c) on the board against the boundary and already placed neighbors.
func (s *Solver) EvaluateSlotPieceScore(b *Board, r, c int, p *puzzle.Piece) (float64, bool) {
	totalScore := 0.0
	matchedEdges := 0

	// 1. TOP EDGE
	if r == 0 {
		if p.Edges[puzzle.Top].Type != puzzle.Flat {
			return math.MaxFloat64, false
		}
	} else {
		if p.Edges[puzzle.Top].Type == puzzle.Flat {
			return math.MaxFloat64, false
		}
		topNeighbor := b.At(r-1, c)
		if topNeighbor != nil {
			res := s.matcher.MatchEdges(p.Edges[puzzle.Top], topNeighbor.Piece.Edges[puzzle.Bottom])
			if !res.Compatible || res.GeomDistance > 0.08 {
				return math.MaxFloat64, false
			}
			totalScore += res.Score
			matchedEdges++
		}
	}

	// 2. BOTTOM EDGE
	if r == s.grid.Rows-1 {
		if p.Edges[puzzle.Bottom].Type != puzzle.Flat {
			return math.MaxFloat64, false
		}
	} else {
		if p.Edges[puzzle.Bottom].Type == puzzle.Flat {
			return math.MaxFloat64, false
		}
		bottomNeighbor := b.At(r+1, c)
		if bottomNeighbor != nil {
			res := s.matcher.MatchEdges(p.Edges[puzzle.Bottom], bottomNeighbor.Piece.Edges[puzzle.Top])
			if !res.Compatible || res.GeomDistance > 0.08 {
				return math.MaxFloat64, false
			}
			totalScore += res.Score
			matchedEdges++
		}
	}

	// 3. LEFT EDGE
	if c == 0 {
		if p.Edges[puzzle.Left].Type != puzzle.Flat {
			return math.MaxFloat64, false
		}
	} else {
		if p.Edges[puzzle.Left].Type == puzzle.Flat {
			return math.MaxFloat64, false
		}
		leftNeighbor := b.At(r, c-1)
		if leftNeighbor != nil {
			res := s.matcher.MatchEdges(p.Edges[puzzle.Left], leftNeighbor.Piece.Edges[puzzle.Right])
			if !res.Compatible || res.GeomDistance > 0.08 {
				return math.MaxFloat64, false
			}
			totalScore += res.Score
			matchedEdges++
		}
	}

	// 4. RIGHT EDGE
	if c == s.grid.Cols-1 {
		if p.Edges[puzzle.Right].Type != puzzle.Flat {
			return math.MaxFloat64, false
		}
	} else {
		if p.Edges[puzzle.Right].Type == puzzle.Flat {
			return math.MaxFloat64, false
		}
		rightNeighbor := b.At(r, c+1)
		if rightNeighbor != nil {
			res := s.matcher.MatchEdges(p.Edges[puzzle.Right], rightNeighbor.Piece.Edges[puzzle.Left])
			if !res.Compatible || res.GeomDistance > 0.08 {
				return math.MaxFloat64, false
			}
			totalScore += res.Score
			matchedEdges++
		}
	}

	return totalScore, true
}

// CandidatePlacement represents a tested piece and rotation.
type CandidatePlacement struct {
	Piece    *puzzle.Piece
	Rotation int
	Score    float64
}

// FindSlotCandidates finds all available pieces and rotations that satisfy constraints at (r, c).
func (s *Solver) FindSlotCandidates(b *Board, r, c int) []CandidatePlacement {
	expectedFlats := 0
	if r == 0 {
		expectedFlats++
	}
	if r == s.grid.Rows-1 {
		expectedFlats++
	}
	if c == 0 {
		expectedFlats++
	}
	if c == s.grid.Cols-1 {
		expectedFlats++
	}

	var candidates []CandidatePlacement

	for _, p := range s.pieces {
		if b.IsPlaced(p.ID) {
			continue
		}
		if p.FlatEdgeCount() != expectedFlats {
			continue
		}

		for rot := 0; rot < 4; rot++ {
			score, valid := s.EvaluateSlotPieceScore(b, r, c, p)
			if valid {
				candidates = append(candidates, CandidatePlacement{
					Piece:    p,
					Rotation: p.Rotation,
					Score:    score,
				})
			}
			p.Rotate90CW()
		}
	}

	// Sort candidates by score (best match first)
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score < candidates[j].Score
	})

	return candidates
}

// CalculateAccuracy evaluates board correctness against ground truth considering possible global puzzle rotations.
func (s *Solver) CalculateAccuracy(b *Board) (float64, int) {
	total := s.grid.TotalPieces()
	bestAccuracy := 0.0
	bestGlobalRot := 0

	rotations := []int{0}
	if s.grid.Rows == s.grid.Cols {
		rotations = []int{0, 90, 180, 270}
	} else {
		rotations = []int{0, 180}
	}

	for _, gRot := range rotations {
		correct := 0
		for r := 0; r < s.grid.Rows; r++ {
			for c := 0; c < s.grid.Cols; c++ {
				p := b.At(r, c)
				if p == nil {
					continue
				}
				expectedR, expectedC := p.Piece.OriginalRow, p.Piece.OriginalCol
				switch gRot {
				case 90:
					expectedR = p.Piece.OriginalCol
					expectedC = s.grid.Cols - 1 - p.Piece.OriginalRow
				case 180:
					expectedR = s.grid.Rows - 1 - p.Piece.OriginalRow
					expectedC = s.grid.Cols - 1 - p.Piece.OriginalCol
				case 270:
					expectedR = s.grid.Rows - 1 - p.Piece.OriginalCol
					expectedC = p.Piece.OriginalRow
				}

				if expectedR == r && expectedC == c && (p.Rotation%360) == gRot {
					correct++
				}
			}
		}
		acc := float64(correct) / float64(total) * 100.0
		if acc > bestAccuracy {
			bestAccuracy = acc
			bestGlobalRot = gRot
		}
	}

	return bestAccuracy, bestGlobalRot
}

// Solve runs the puzzle solver and returns the assembled board.
func (s *Solver) Solve() (*SolveResult, error) {
	board := NewBoard(s.grid)

	success := s.backtrack(board, 0)
	if !success {
		return nil, errors.New("failed to find valid puzzle assembly")
	}

	acc, gRot := s.CalculateAccuracy(board)

	return &SolveResult{
		Board:           board,
		Accuracy:        acc,
		GlobalRotation:  gRot,
		TotalPlacements: s.grid.TotalPieces(),
	}, nil
}

// backtrack recursively fills the board using Most Constrained Variable (MRV).
func (s *Solver) backtrack(b *Board, depth int) bool {
	if len(b.Placed) == s.grid.TotalPieces() {
		return true
	}

	bestR, bestC := -1, -1
	maxNeighbors := -1
	var bestCandidates []CandidatePlacement

	for r := 0; r < s.grid.Rows; r++ {
		for c := 0; c < s.grid.Cols; c++ {
			if b.At(r, c) != nil {
				continue
			}
			neighbors := b.PlacedNeighborsCount(r, c)
			if neighbors > maxNeighbors {
				candidates := s.FindSlotCandidates(b, r, c)
				if len(candidates) == 0 && (r == 0 && c == 0 && len(b.Placed) == 0) {
					// Starting corner
				} else if len(candidates) == 0 && len(b.Placed) > 0 {
					return false // Dead end
				}
				maxNeighbors = neighbors
				bestR, bestC = r, c
				bestCandidates = candidates
			}
		}
	}

	if bestR == -1 {
		return true
	}

	for _, cand := range bestCandidates {
		for cand.Piece.Rotation != cand.Rotation {
			cand.Piece.Rotate90CW()
		}

		b.Place(bestR, bestC, cand.Piece)

		if s.backtrack(b, depth+1) {
			return true
		}

		b.Remove(bestR, bestC)
	}

	return false
}
