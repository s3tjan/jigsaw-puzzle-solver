package registration_test

import (
	"image"
	"image/color"
	"jig/pkg/puzzle"
	"jig/pkg/registration"
	"testing"
)

func TestCieLabConversion(t *testing.T) {
	// D65 reference values:
	// Pure black (0, 0, 0) -> L=0, a=0, b=0
	L0, a0, b0 := registration.RGBToLab(0, 0, 0)
	if L0 != 0 || a0 != 0 || b0 != 0 {
		t.Errorf("expected black to be (0,0,0), got (%f,%f,%f)", L0, a0, b0)
	}

	// Pure white (255, 255, 255) -> L=100, a=0, b=0
	Lw, aw, bw := registration.RGBToLab(255, 255, 255)
	if Lw < 99.9 || aw < -1.0 || aw > 1.0 || bw < -1.0 || bw > 1.0 {
		t.Errorf("expected white to be ~ (100, 0, 0), got (%f,%f,%f)", Lw, aw, bw)
	}

	// Pure red (255, 0, 0) has high positive a*
	_, aRed, _ := registration.RGBToLab(255, 0, 0)
	if aRed < 50.0 {
		t.Errorf("expected red to have high positive a*, got %f", aRed)
	}
}

func TestDimmedPieceInvariance(t *testing.T) {
	// Create bright piece vs 50% dimmed piece
	bright := image.NewRGBA(image.Rect(0, 0, 40, 40))
	dimmed := image.NewRGBA(image.Rect(0, 0, 40, 40))

	for y := 0; y < 40; y++ {
		for x := 0; x < 40; x++ {
			bright.SetRGBA(x, y, color.RGBA{R: 240, G: 180, B: 30, A: 255}) // Warm yellow
			dimmed.SetRGBA(x, y, color.RGBA{R: 120, G: 90, B: 15, A: 255})  // Same hue, 50% dimmer
		}
	}

	dBright := registration.ExtractDescriptor(bright, nil)
	dDimmed := registration.ExtractDescriptor(dimmed, nil)

	dist := registration.DescriptorDistance(dBright, dDimmed)
	// Because chromaticity (a*, b*) is preserved, distance should be very low (< 0.20)
	// Even though raw RGB Euclidean distance is huge (~150)
	if dist > 0.20 {
		t.Fatalf("expected low distance for dimmed piece due to CIE Lab invariance, got %f", dist)
	}
}

func TestTopologyConstraintFiltering(t *testing.T) {
	master := image.NewRGBA(image.Rect(0, 0, 400, 400))
	grid := puzzle.Grid{Rows: 4, Cols: 4}
	refMap := registration.NewReferenceMap(master, grid)

	desc := registration.ExtractDescriptor(master, nil)

	// Interior piece (0 flat edges)
	candidates := refMap.LocateCandidatesWithTopology(desc, 0, 100)
	for _, c := range candidates {
		if grid.IsBorder(c.Row, c.Col) {
			t.Errorf("interior candidate returned border/corner slot (%d, %d)", c.Row, c.Col)
		}
	}

	// Corner piece (2 flat edges)
	cornerCandidates := refMap.LocateCandidatesWithTopology(desc, 2, 100)
	for _, c := range cornerCandidates {
		if !grid.IsCorner(c.Row, c.Col) {
			t.Errorf("corner candidate returned non-corner slot (%d, %d)", c.Row, c.Col)
		}
	}
}
