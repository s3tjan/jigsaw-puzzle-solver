package curve_test

import (
	"jig/pkg/curve"
	"jig/pkg/puzzle"
	"math/rand"
	"testing"
)

func TestCubicBezierEndpoints(t *testing.T) {
	cb := curve.CubicBezier{
		P0: puzzle.Point2D{X: 0, Y: 0},
		P1: puzzle.Point2D{X: 10, Y: 20},
		P2: puzzle.Point2D{X: 20, Y: 20},
		P3: puzzle.Point2D{X: 30, Y: 0},
	}

	start := cb.PointAt(0.0)
	if start.X != 0 || start.Y != 0 {
		t.Errorf("expected start (0,0), got (%f,%f)", start.X, start.Y)
	}

	end := cb.PointAt(1.0)
	if end.X != 30 || end.Y != 0 {
		t.Errorf("expected end (30,0), got (%f,%f)", end.X, end.Y)
	}

	samples := cb.Sample(10)
	if len(samples) != 10 {
		t.Errorf("expected 10 samples, got %d", len(samples))
	}
}

func TestTabProfileGeneration(t *testing.T) {
	rng := rand.New(rand.NewSource(123))
	cfg := curve.DefaultProfileConfig()
	composite := curve.GenerateNormalizedTabProfile(cfg, rng)

	pts := composite.Sample(8)
	if len(pts) == 0 {
		t.Fatalf("expected non-empty profile points")
	}

	// First point should be around (0,0) and last around (1,0)
	if pts[0].X < -0.01 || pts[0].X > 0.01 {
		t.Errorf("expected first point X ~ 0, got %f", pts[0].X)
	}
	last := pts[len(pts)-1]
	if last.X < 0.99 || last.X > 1.01 {
		t.Errorf("expected last point X ~ 1, got %f", last.X)
	}
}
