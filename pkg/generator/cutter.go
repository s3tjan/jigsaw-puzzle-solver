package generator

import (
	"image"
	"jig/pkg/curve"
	"jig/pkg/matcher"
	"jig/pkg/puzzle"
	"math/rand"
)

// CutterConfig provides configuration for cutting a puzzle.
type CutterConfig struct {
	Rows            int
	Cols            int
	PointsPerEdge   int
	ProfileConfig   curve.JigsawProfileConfig
	Seed            int64
	ExtractImages   bool // If true, extracts pixel sub-images and masks
}

// DefaultCutterConfig returns default cutting parameters.
func DefaultCutterConfig(rows, cols int) CutterConfig {
	return CutterConfig{
		Rows:          rows,
		Cols:          cols,
		PointsPerEdge: 40,
		ProfileConfig: curve.DefaultProfileConfig(),
		Seed:          42,
		ExtractImages: true,
	}
}

// CutResult holds the generated puzzle pieces and grid geometry.
type CutResult struct {
	Grid   puzzle.Grid
	Pieces []*puzzle.Piece
	Width  int
	Height int
}

// CutPuzzle cuts an image into a grid of interlocking puzzle pieces.
func CutPuzzle(img image.Image, cfg CutterConfig) (*CutResult, error) {
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	cellW := float64(w) / float64(cfg.Cols)
	cellH := float64(h) / float64(cfg.Rows)

	rng := rand.New(rand.NewSource(cfg.Seed))

	// Pre-generate horizontal edges: (Rows-1) x Cols edges
	type CutEdge struct {
		Points  []puzzle.Point2D
		TabSign int // +1 or -1
	}

	horizEdges := make([][]CutEdge, cfg.Rows-1)
	for r := 0; r < cfg.Rows-1; r++ {
		horizEdges[r] = make([]CutEdge, cfg.Cols)
		for c := 0; c < cfg.Cols; c++ {
			pStart := puzzle.Point2D{X: float64(c) * cellW, Y: float64(r+1) * cellH}
			pEnd := puzzle.Point2D{X: float64(c+1) * cellW, Y: float64(r+1) * cellH}

			tabCurve := curve.GenerateNormalizedTabProfile(cfg.ProfileConfig, rng)
			normPts := tabCurve.Sample(cfg.PointsPerEdge / 5)

			sign := 1
			if rng.Intn(2) == 0 {
				sign = -1
			}

			flip := sign < 0
			worldPts := curve.Transform(normPts, pStart, pEnd, flip)

			horizEdges[r][c] = CutEdge{
				Points:  worldPts,
				TabSign: sign,
			}
		}
	}

	// Pre-generate vertical edges: Rows x (Cols-1) edges
	vertEdges := make([][]CutEdge, cfg.Rows)
	for r := 0; r < cfg.Rows; r++ {
		vertEdges[r] = make([]CutEdge, cfg.Cols-1)
		for c := 0; c < cfg.Cols-1; c++ {
			pStart := puzzle.Point2D{X: float64(c+1) * cellW, Y: float64(r) * cellH}
			pEnd := puzzle.Point2D{X: float64(c+1) * cellW, Y: float64(r+1) * cellH}

			tabCurve := curve.GenerateNormalizedTabProfile(cfg.ProfileConfig, rng)
			normPts := tabCurve.Sample(cfg.PointsPerEdge / 5)

			sign := 1
			if rng.Intn(2) == 0 {
				sign = -1
			}

			flip := sign < 0
			worldPts := curve.Transform(normPts, pStart, pEnd, flip)

			vertEdges[r][c] = CutEdge{
				Points:  worldPts,
				TabSign: sign,
			}
		}
	}

	pieces := make([]*puzzle.Piece, 0, cfg.Rows*cfg.Cols)
	idCounter := 0

	for r := 0; r < cfg.Rows; r++ {
		for c := 0; c < cfg.Cols; c++ {
			pTopLeft := puzzle.Point2D{X: float64(c) * cellW, Y: float64(r) * cellH}
			pTopRight := puzzle.Point2D{X: float64(c+1) * cellW, Y: float64(r) * cellH}
			pBottomRight := puzzle.Point2D{X: float64(c+1) * cellW, Y: float64(r+1) * cellH}
			pBottomLeft := puzzle.Point2D{X: float64(c) * cellW, Y: float64(r+1) * cellH}

			var topPts, rightPts, bottomPts, leftPts []puzzle.Point2D
			var topType, rightType, bottomType, leftType puzzle.EdgeType

			// 1. TOP EDGE
			if r == 0 {
				topType = puzzle.Flat
				topPts = curve.GenerateStraightEdge(pTopLeft, pTopRight, cfg.PointsPerEdge)
			} else {
				e := horizEdges[r-1][c]
				topPts = make([]puzzle.Point2D, len(e.Points))
				copy(topPts, e.Points)
				if e.TabSign > 0 {
					topType = puzzle.Blank
				} else {
					topType = puzzle.Tab
				}
			}

			// 2. RIGHT EDGE
			if c == cfg.Cols-1 {
				rightType = puzzle.Flat
				rightPts = curve.GenerateStraightEdge(pTopRight, pBottomRight, cfg.PointsPerEdge)
			} else {
				e := vertEdges[r][c]
				rightPts = make([]puzzle.Point2D, len(e.Points))
				copy(rightPts, e.Points)
				if e.TabSign > 0 {
					rightType = puzzle.Tab
				} else {
					rightType = puzzle.Blank
				}
			}

			// 3. BOTTOM EDGE
			if r == cfg.Rows-1 {
				bottomType = puzzle.Flat
				bottomPts = curve.GenerateStraightEdge(pBottomRight, pBottomLeft, cfg.PointsPerEdge)
			} else {
				e := horizEdges[r][c]
				bottomPts = curve.Reverse(e.Points)
				if e.TabSign > 0 {
					bottomType = puzzle.Tab
				} else {
					bottomType = puzzle.Blank
				}
			}

			// 4. LEFT EDGE
			if c == 0 {
				leftType = puzzle.Flat
				leftPts = curve.GenerateStraightEdge(pBottomLeft, pTopLeft, cfg.PointsPerEdge)
			} else {
				e := vertEdges[r][c-1]
				leftPts = curve.Reverse(e.Points)
				if e.TabSign > 0 {
					leftType = puzzle.Blank
				} else {
					leftType = puzzle.Tab
				}
			}

			piece := &puzzle.Piece{
				ID:          idCounter,
				OriginalRow: r,
				OriginalCol: c,
				Edges: [4]puzzle.Edge{
					{Dir: puzzle.Top, Type: topType, Points: topPts, Colors: matcher.ExtractEdgeBoundaryColors(img, topPts)},
					{Dir: puzzle.Right, Type: rightType, Points: rightPts, Colors: matcher.ExtractEdgeBoundaryColors(img, rightPts)},
					{Dir: puzzle.Bottom, Type: bottomType, Points: bottomPts, Colors: matcher.ExtractEdgeBoundaryColors(img, bottomPts)},
					{Dir: puzzle.Left, Type: leftType, Points: leftPts, Colors: matcher.ExtractEdgeBoundaryColors(img, leftPts)},
				},
				Rotation: 0,
			}

			// Assemble closed polygon path (clockwise)
			var poly []puzzle.Point2D
			poly = append(poly, topPts...)
			poly = append(poly, rightPts[1:]...)
			poly = append(poly, bottomPts[1:]...)
			poly = append(poly, leftPts[1:len(leftPts)-1]...)

			if cfg.ExtractImages && img != nil {
				pieceImg, mask, bounds := ExtractPieceImage(img, poly)
				piece.Image = pieceImg
				piece.Mask = mask
				piece.Bounds = bounds
			} else {
				piece.Bounds = BoundingBox(poly)
			}

			pieces = append(pieces, piece)
			idCounter++
		}
	}

	return &CutResult{
		Grid:   puzzle.Grid{Rows: cfg.Rows, Cols: cfg.Cols},
		Pieces: pieces,
		Width:  w,
		Height: h,
	}, nil
}
