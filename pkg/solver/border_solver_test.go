package solver_test

import (
	"image"
	"image/color"
	"jig/pkg/generator"
	"jig/pkg/matcher"
	"jig/pkg/solver"
	"math/rand"
	"testing"
	"time"
)

func createTestImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, color.RGBA{
				R: uint8((x * 255) / w),
				G: uint8((y * 255) / h),
				B: uint8(((x + y) * 128) / (w + h)),
				A: 255,
			})
		}
	}
	return img
}

func TestBorderSolver4x5(t *testing.T) {
	img := createTestImage(500, 400)
	res, err := generator.CutPuzzle(img, generator.DefaultCutterConfig(4, 5))
	if err != nil {
		t.Fatalf("failed to cut puzzle: %v", err)
	}

	rng := rand.New(rand.NewSource(12345))
	solver.ShuffleAndRotate(res.Pieces, rng)

	m := matcher.NewDefaultMatcher()
	borderSolver := solver.NewBorderSolver(res.Grid, res.Pieces, m)

	start := time.Now()
	board, err := borderSolver.SolveBorder()
	duration := time.Since(start)

	if err != nil {
		t.Fatalf("border solver failed: %v", err)
	}

	t.Logf("Border 4x5 solved in %v", duration)

	// Verify all perimeter slots are filled
	for r := 0; r < res.Grid.Rows; r++ {
		for c := 0; c < res.Grid.Cols; c++ {
			if res.Grid.IsBorder(r, c) {
				p := board.At(r, c)
				if p == nil {
					t.Errorf("unfilled border slot at (%d,%d)", r, c)
				}
			} else {
				if board.At(r, c) != nil {
					t.Errorf("interior slot (%d,%d) should remain unfilled in border solver", r, c)
				}
			}
		}
	}
}

func TestBorderSolverLarge10x10(t *testing.T) {
	// 10x10 puzzle: 36 border pieces (4 corners, 32 borders), 64 interior pieces
	img := createTestImage(800, 800)
	res, err := generator.CutPuzzle(img, generator.DefaultCutterConfig(10, 10))
	if err != nil {
		t.Fatalf("failed to cut puzzle: %v", err)
	}

	rng := rand.New(rand.NewSource(777))
	solver.ShuffleAndRotate(res.Pieces, rng)

	m := matcher.NewDefaultMatcher()
	borderSolver := solver.NewBorderSolver(res.Grid, res.Pieces, m)

	start := time.Now()
	board, err := borderSolver.SolveBorder()
	duration := time.Since(start)

	if err != nil {
		t.Fatalf("border solver failed on 10x10: %v", err)
	}

	t.Logf("10x10 Border (36 perimeter pieces) solved in %v!", duration)

	// Confirm that every border slot is filled
	count := 0
	for r := 0; r < 10; r++ {
		for c := 0; c < 10; c++ {
			if res.Grid.IsBorder(r, c) {
				p := board.At(r, c)
				if p == nil {
					t.Fatalf("missing piece at (%d,%d)", r, c)
				}
				count++
			}
		}
	}
	if count != 36 {
		t.Errorf("expected 36 border pieces placed, got %d", count)
	}
}

func TestBorderSolver1000PieceScale(t *testing.T) {
	// 25x40 grid = 1000 pieces!
	// 4 corners, 2*(23) + 2*(38) = 46 + 76 = 122 borders -> 126 border pieces total!
	img := createTestImage(1200, 800)
	res, err := generator.CutPuzzle(img, generator.DefaultCutterConfig(25, 40))
	if err != nil {
		t.Fatalf("failed to cut 1000 piece puzzle: %v", err)
	}

	rng := rand.New(rand.NewSource(42))
	solver.ShuffleAndRotate(res.Pieces, rng)

	m := matcher.NewDefaultMatcher()
	borderSolver := solver.NewBorderSolver(res.Grid, res.Pieces, m)

	start := time.Now()
	board, err := borderSolver.SolveBorder()
	duration := time.Since(start)

	if err != nil {
		t.Fatalf("1000-piece border failed: %v", err)
	}

	t.Logf("🚀 1000-piece puzzle border (126 pieces) solved in %v!", duration)

	count := 0
	for r := 0; r < 25; r++ {
		for c := 0; c < 40; c++ {
			if res.Grid.IsBorder(r, c) {
				if board.At(r, c) == nil {
					t.Fatalf("missing border piece at (%d,%d)", r, c)
				}
				count++
			}
		}
	}
	if count != 126 {
		t.Errorf("expected 126 border pieces, got %d", count)
	}
}
