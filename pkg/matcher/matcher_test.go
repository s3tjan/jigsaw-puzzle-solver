package matcher_test

import (
	"image"
	"jig/pkg/generator"
	"jig/pkg/matcher"
	"jig/pkg/puzzle"
	"testing"
)

func TestCurveDistance(t *testing.T) {
	// Cut a 2x2 puzzle to get authentic adjacent edges
	dummyImg := image.NewRGBA(image.Rect(0, 0, 200, 200))
	res, err := generator.CutPuzzle(dummyImg, generator.DefaultCutterConfig(2, 2))
	if err != nil {
		t.Fatalf("failed to cut puzzle: %v", err)
	}

	// Piece (0, 0) Right edge should mate with Piece (0, 1) Left edge
	p00 := res.Pieces[0]
	p01 := res.Pieces[1]

	edgeRight := p00.Edges[puzzle.Right]
	edgeLeft := p01.Edges[puzzle.Left]

	dist := matcher.CurveDistance(edgeRight, edgeLeft)
	if dist > 0.05 {
		t.Fatalf("expected near-zero curve distance between true neighbors, got %f", dist)
	}

	// Non-complementary edges should return IncompatibleDistance
	edgeTop := p00.Edges[puzzle.Top] // Flat
	incompatDist := matcher.CurveDistance(edgeTop, edgeLeft)
	if incompatDist < matcher.IncompatibleDistance {
		t.Fatalf("expected IncompatibleDistance for non-complementary edges, got %f", incompatDist)
	}
}
