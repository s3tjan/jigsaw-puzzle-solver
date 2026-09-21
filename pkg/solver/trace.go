package solver

// PlacementStep records a single step during puzzle assembly for visualization.
type PlacementStep struct {
	StepIndex   int     `json:"step_index"`
	Row         int     `json:"row"`
	Col         int     `json:"col"`
	PieceID     int     `json:"piece_id"`
	Rotation    int     `json:"rotation"` // degrees
	Score       float64 `json:"score"`
	Action      string  `json:"action"` // "place" or "backtrack"
}

// SolveWithTrace performs solving while recording every placement action for step-by-step playback.
func (s *Solver) SolveWithTrace() (*SolveResult, []PlacementStep, error) {
	board := NewBoard(s.grid)
	var trace []PlacementStep
	stepCounter := 0

	var recordPlacement func(b *Board, depth int) bool
	recordPlacement = func(b *Board, depth int) bool {
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
						return false
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
			stepCounter++
			trace = append(trace, PlacementStep{
				StepIndex: stepCounter,
				Row:       bestR,
				Col:       bestC,
				PieceID:   cand.Piece.ID,
				Rotation:  cand.Rotation,
				Score:     cand.Score,
				Action:    "place",
			})

			if recordPlacement(b, depth+1) {
				return true
			}

			b.Remove(bestR, bestC)
			stepCounter++
			trace = append(trace, PlacementStep{
				StepIndex: stepCounter,
				Row:       bestR,
				Col:       bestC,
				PieceID:   cand.Piece.ID,
				Rotation:  cand.Rotation,
				Score:     cand.Score,
				Action:    "backtrack",
			})
		}

		return false
	}

	success := recordPlacement(board, 0)
	if !success {
		return nil, trace, nil
	}

	acc, gRot := s.CalculateAccuracy(board)

	return &SolveResult{
		Board:           board,
		Accuracy:        acc,
		GlobalRotation:  gRot,
		TotalPlacements: s.grid.TotalPieces(),
	}, trace, nil
}
