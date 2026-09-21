package generator_test

import (
	"image"
	"image/color"
	"image/draw"
	"jig/pkg/generator"
	"jig/pkg/puzzle"
	"testing"
)

func createTestGradientImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{
				R: uint8(float64(x) / float64(w) * 255),
				G: uint8(float64(y) / float64(h) * 255),
				B: 128,
				A: 255,
			})
		}
	}
	return img
}

func TestCutPuzzleComplementaryEdges(t *testing.T) {
	img := createTestGradientImage(300, 300)
	cfg := generator.DefaultCutterConfig(3, 3)
	res, err := generator.CutPuzzle(img, cfg)
	if err != nil {
		t.Fatalf("unexpected error cutting puzzle: %v", err)
	}

	if len(res.Pieces) != 9 {
		t.Fatalf("expected 9 pieces, got %d", len(res.Pieces))
	}

	// Index pieces by (row, col)
	gridPieces := make([][]*puzzle.Piece, 3)
	for r := 0; r < 3; r++ {
		gridPieces[r] = make([]*puzzle.Piece, 3)
	}
	for _, p := range res.Pieces {
		gridPieces[p.OriginalRow][p.OriginalCol] = p
	}

	// Verify Horizontal adjacency: piece(r, c) Right edge <-> piece(r, c+1) Left edge
	for r := 0; r < 3; r++ {
		for c := 0; c < 2; c++ {
			pLeft := gridPieces[r][c]
			pRight := gridPieces[r][c+1]

			if !pLeft.Edges[puzzle.Right].IsComplementary(pRight.Edges[puzzle.Left]) {
				t.Errorf("horizontal edge mismatch at (%d,%d) Right (%v) and (%d,%d) Left (%v)",
					r, c, pLeft.Edges[puzzle.Right].Type,
					r, c+1, pRight.Edges[puzzle.Left].Type)
			}
		}
	}

	// Verify Vertical adjacency: piece(r, c) Bottom edge <-> piece(r+1, c) Top edge
	for r := 0; r < 2; r++ {
		for c := 0; c < 3; c++ {
			pTop := gridPieces[r][c]
			pBottom := gridPieces[r+1][c]

			if !pTop.Edges[puzzle.Bottom].IsComplementary(pBottom.Edges[puzzle.Top]) {
				t.Errorf("vertical edge mismatch at (%d,%d) Bottom (%v) and (%d,%d) Top (%v)",
					r, c, pTop.Edges[puzzle.Bottom].Type,
					r+1, c, pBottom.Edges[puzzle.Top].Type)
			}
		}
	}

	// Check classifications: 4 corners, 4 borders, 1 interior for 3x3
	corners, borders, interiors := 0, 0, 0
	for _, p := range res.Pieces {
		switch p.Classification() {
		case puzzle.ClassCorner:
			corners++
		case puzzle.ClassBorder:
			borders++
		case puzzle.ClassInterior:
			interiors++
		}
	}

	if corners != 4 || borders != 4 || interiors != 1 {
		t.Errorf("expected 4 corners, 4 borders, 1 interior. Got corners=%d, borders=%d, interiors=%d",
			corners, borders, interiors)
	}
}

func suppressUnusedDraw() {
	_ = draw.Src
}
