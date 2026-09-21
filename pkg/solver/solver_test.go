package solver_test

import (
	"image"
	"jig/pkg/generator"
	"jig/pkg/registration"
	"jig/pkg/solver"
	"image/color"
	"math/rand"
	"testing"
)

func TestSolvePuzzle3x3(t *testing.T) {
	dummyImg := image.NewRGBA(image.Rect(0, 0, 300, 300))
	res, err := generator.CutPuzzle(dummyImg, generator.DefaultCutterConfig(3, 3))
	if err != nil {
		t.Fatalf("failed to cut puzzle: %v", err)
	}

	// Shuffle pieces and rotate them
	rng := rand.New(rand.NewSource(99))
	solver.ShuffleAndRotate(res.Pieces, rng)

	s := solver.NewSolver(res.Grid, res.Pieces, solver.DefaultSolverConfig())
	result, err := s.Solve()
	if err != nil {
		t.Fatalf("solver failed: %v", err)
	}

	if result.Accuracy != 100.0 {
		t.Fatalf("expected 100%% accuracy (modulo global rotation), got %.1f%%", result.Accuracy)
	}

	// Verify all cells filled
	for r := 0; r < 3; r++ {
		for c := 0; c < 3; c++ {
			p := result.Board.At(r, c)
			if p == nil {
				t.Fatalf("unfilled cell at (%d, %d)", r, c)
			}
		}
	}
}

func TestSolvePuzzle4x5(t *testing.T) {
	dummyImg := image.NewRGBA(image.Rect(0, 0, 400, 500))
	res, err := generator.CutPuzzle(dummyImg, generator.DefaultCutterConfig(4, 5))
	if err != nil {
		t.Fatalf("failed to cut puzzle: %v", err)
	}

	rng := rand.New(rand.NewSource(1234))
	solver.ShuffleAndRotate(res.Pieces, rng)

	s := solver.NewSolver(res.Grid, res.Pieces, solver.DefaultSolverConfig())
	result, err := s.Solve()
	if err != nil {
		t.Fatalf("solver failed: %v", err)
	}

	if result.Accuracy != 100.0 {
		t.Fatalf("expected 100%% accuracy on 4x5, got %.1f%%", result.Accuracy)
	}
}

func TestSolvePuzzle6x6(t *testing.T) {
	dummyImg := image.NewRGBA(image.Rect(0, 0, 600, 600))
	for y := 0; y < 600; y++ {
		for x := 0; x < 600; x++ {
			dummyImg.SetRGBA(x, y, color.RGBA{
				R: uint8(x % 256),
				G: uint8(y % 256),
				B: uint8((x + y) % 256),
				A: 255,
			})
		}
	}
	res, err := generator.CutPuzzle(dummyImg, generator.DefaultCutterConfig(6, 6))
	if err != nil {
		t.Fatalf("failed to cut puzzle: %v", err)
	}

	rng := rand.New(rand.NewSource(42))
	solver.ShuffleAndRotate(res.Pieces, rng)

	s := solver.NewSolver(res.Grid, res.Pieces, solver.DefaultSolverConfig())
	result, err := s.Solve()
	if err != nil {
		t.Fatalf("solver failed on 6x6: %v", err)
	}

	if result.Accuracy != 100.0 {
		t.Fatalf("expected 100%% accuracy on 6x6, got %.1f%%", result.Accuracy)
	}
}

func TestSolverWithReferencePrior(t *testing.T) {
	img := createTestImage(400, 400)
	res, err := generator.CutPuzzle(img, generator.DefaultCutterConfig(4, 4))
	if err != nil {
		t.Fatalf("failed to cut puzzle: %v", err)
	}

	rng := rand.New(rand.NewSource(999))
	solver.ShuffleAndRotate(res.Pieces, rng)

	refMap := registration.NewReferenceMap(img, res.Grid)
	cfg := solver.DefaultSolverConfig()
	cfg.ReferenceMap = refMap
	cfg.RefWeight = 2.0

	s := solver.NewSolver(res.Grid, res.Pieces, cfg)
	result, err := s.Solve()
	if err != nil {
		t.Fatalf("solver failed with reference prior: %v", err)
	}

	if result.Accuracy != 100.0 {
		t.Fatalf("expected 100%% accuracy with reference prior, got %.1f%%", result.Accuracy)
	}
}
