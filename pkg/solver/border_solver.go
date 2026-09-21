package solver

import (
	"errors"
	"jig/pkg/matcher"
	"jig/pkg/puzzle"
	"math"
)

// BorderSolver assembles only the corners and border pieces into the perimeter frame.
type BorderSolver struct {
	grid    puzzle.Grid
	corners []*puzzle.Piece
	borders []*puzzle.Piece
	matcher *matcher.EdgeMatcher
	compat  *BorderCompatibility
}

// NewBorderSolver partitions pieces into corners & borders.
func NewBorderSolver(grid puzzle.Grid, pieces []*puzzle.Piece, m *matcher.EdgeMatcher) *BorderSolver {
	var corners []*puzzle.Piece
	var borders []*puzzle.Piece

	for _, p := range pieces {
		switch p.Classification() {
		case puzzle.ClassCorner:
			corners = append(corners, p)
		case puzzle.ClassBorder:
			borders = append(borders, p)
		}
	}

	return &BorderSolver{
		grid:    grid,
		corners: corners,
		borders: borders,
		matcher: m,
		compat:  &BorderCompatibility{m: m},
	}
}

// OrientCorner sets piece rotation so its two flat edges face (flatDir1, flatDir2).
func OrientCorner(p *puzzle.Piece, flatDir1, flatDir2 puzzle.Direction) bool {
	for rot := 0; rot < 4; rot++ {
		if p.Edges[flatDir1].Type == puzzle.Flat && p.Edges[flatDir2].Type == puzzle.Flat {
			return true
		}
		p.Rotate90CW()
	}
	return false
}

// OrientBorder sets piece rotation so its single flat edge faces flatDir.
func OrientBorder(p *puzzle.Piece, flatDir puzzle.Direction) bool {
	for rot := 0; rot < 4; rot++ {
		if p.Edges[flatDir].Type == puzzle.Flat {
			return true
		}
		p.Rotate90CW()
	}
	return false
}

// SolveBorder builds the closed rectangular perimeter frame.
func (bs *BorderSolver) SolveBorder() (*Board, error) {
	if len(bs.corners) != 4 {
		return nil, errors.New("expected exactly 4 corner pieces")
	}
	expectedBorders := bs.grid.BorderCount()
	if len(bs.borders) != expectedBorders {
		return nil, errors.New("mismatched border piece count")
	}

	R := bs.grid.Rows
	C := bs.grid.Cols

	// Try each corner as the top-left anchor (0,0)
	for cIdx := 0; cIdx < 4; cIdx++ {
		board := NewBoard(bs.grid)
		anchor := bs.corners[cIdx]
		OrientCorner(anchor, puzzle.Top, puzzle.Left)
		board.Place(0, 0, anchor)

		usedCorners := map[int]bool{anchor.ID: true}
		usedBorders := make(map[int]bool)

		// 1. Solve Top Wall: (0, 1) to (0, C-2)
		if bs.solveWall(board, usedBorders, 0, 1, 0, 1, C-2, puzzle.Top, puzzle.Right, puzzle.Left) {
			// Fit Top-Right Corner at (0, C-1)
			if bs.fitCorner(board, usedCorners, 0, C-1, puzzle.Top, puzzle.Right, 0, C-2, puzzle.Right, puzzle.Left) {
				// 2. Solve Right Wall: (1, C-1) to (R-2, C-1)
				if bs.solveWall(board, usedBorders, 1, C-1, 1, 0, R-2, puzzle.Right, puzzle.Bottom, puzzle.Top) {
					// Fit Bottom-Right Corner at (R-1, C-1)
					if bs.fitCorner(board, usedCorners, R-1, C-1, puzzle.Bottom, puzzle.Right, R-2, C-1, puzzle.Bottom, puzzle.Top) {
						// 3. Solve Bottom Wall: (R-1, C-2) to (R-1, 1)
						if bs.solveWall(board, usedBorders, R-1, C-2, 0, -1, C-2, puzzle.Bottom, puzzle.Left, puzzle.Right) {
							// Fit Bottom-Left Corner at (R-1, 0)
							if bs.fitCorner(board, usedCorners, R-1, 0, puzzle.Bottom, puzzle.Left, R-1, 1, puzzle.Left, puzzle.Right) {
								// 4. Solve Left Wall: (R-2, 0) to (1, 0)
								if bs.solveWall(board, usedBorders, R-2, 0, -1, 0, R-2, puzzle.Left, puzzle.Top, puzzle.Bottom) {
									// Final closure verification
									lastLeft := board.At(1, 0)
									firstCorner := board.At(0, 0)
									res := bs.matcher.MatchEdges(lastLeft.Piece.Edges[puzzle.Top], firstCorner.Piece.Edges[puzzle.Bottom])
									if res.Compatible && res.GeomDistance < 0.08 {
										return board, nil
									}
								}
							}
						}
					}
				}
			}
		}
	}

	return nil, errors.New("failed to close border perimeter loop")
}

// solveWall recursively chains wall border pieces from start to end along a single edge.
func (bs *BorderSolver) solveWall(b *Board, used map[int]bool, r, c int, dr, dc int, stepsRemaining int, flatDir, forwardDir, backwardDir puzzle.Direction) bool {
	if stepsRemaining == 0 {
		return true
	}

	prevPiece := b.At(r-dr, c-dc)
	if prevPiece == nil {
		return false
	}
	prevEdge := prevPiece.Piece.Edges[forwardDir]

	// Dynamically query compatible candidates
	candidates := bs.compat.FindMatchingBorderPieces(prevEdge, bs.borders, used, flatDir, backwardDir)

	for _, candPiece := range candidates {
		b.Place(r, c, candPiece)
		used[candPiece.ID] = true

		if bs.solveWall(b, used, r+dr, c+dc, dr, dc, stepsRemaining-1, flatDir, forwardDir, backwardDir) {
			return true
		}

		b.Remove(r, c)
		delete(used, candPiece.ID)
	}

	return false
}

// fitCorner finds an available corner piece that fits into slot (r, c).
func (bs *BorderSolver) fitCorner(b *Board, usedCorners map[int]bool, r, c int, flatDir1, flatDir2 puzzle.Direction, prevR, prevC int, prevEdgeDir, cornerMeetDir puzzle.Direction) bool {
	prevPiece := b.At(prevR, prevC)
	if prevPiece == nil {
		return false
	}
	prevEdge := prevPiece.Piece.Edges[prevEdgeDir]

	bestScore := math.MaxFloat64
	var bestCorner *puzzle.Piece

	for _, cp := range bs.corners {
		if usedCorners[cp.ID] {
			continue
		}
		if !OrientCorner(cp, flatDir1, flatDir2) {
			continue
		}
		res := bs.matcher.MatchEdges(cp.Edges[cornerMeetDir], prevEdge)
		if res.Compatible && res.GeomDistance < 0.08 && res.Score < bestScore {
			bestScore = res.Score
			bestCorner = cp
		}
	}

	if bestCorner != nil {
		b.Place(r, c, bestCorner)
		usedCorners[bestCorner.ID] = true
		return true
	}

	return false
}
