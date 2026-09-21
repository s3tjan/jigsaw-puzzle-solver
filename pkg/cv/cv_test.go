package cv_test

import (
	"image"
	"image/color"
	"image/draw"
	"jig/pkg/cv"
	"jig/pkg/puzzle"
	"testing"
)

// createSyntheticPhysicalPiece creates a piece on a dark background
func createSyntheticPhysicalPiece(w, h int) image.Image {
	canvas := image.NewRGBA(image.Rect(0, 0, w, h))
	// Fill background dark
	draw.Draw(canvas, canvas.Bounds(), &image.Uniform{color.RGBA{15, 15, 20, 255}}, image.Point{}, draw.Src)

	// Draw bright puzzle piece with a tab on top
	// Piece body from x=50..150, y=60..160
	for y := 60; y < 160; y++ {
		for x := 50; x < 150; x++ {
			canvas.SetRGBA(x, y, color.RGBA{R: 200, G: 180, B: 120, A: 255})
		}
	}
	// Tab protruding upward from y=40..60, x=85..115
	for y := 40; y < 60; y++ {
		for x := 85; x < 115; x++ {
			canvas.SetRGBA(x, y, color.RGBA{R: 200, G: 180, B: 120, A: 255})
		}
	}

	return canvas
}

func TestSegmentPiece(t *testing.T) {
	img := createSyntheticPhysicalPiece(200, 200)

	// Threshold at luminance 50, dark background (invert=false)
	result, err := cv.SegmentPiece(img, 50, false)
	if err != nil {
		t.Fatalf("SegmentPiece failed: %v", err)
	}

	if len(result.FullContour) < 50 {
		t.Errorf("expected substantial contour, got %d points", len(result.FullContour))
	}

	// Corners should be 4
	if len(result.CornerPoints) != 4 {
		t.Errorf("expected 4 corners, got %d", len(result.CornerPoints))
	}

	// Edge 0 (Top) should be classified as Tab
	if result.EdgeTypes[0] != puzzle.Tab {
		t.Errorf("expected Edge 0 (Top) to be Tab, got %v", result.EdgeTypes[0])
	}
}
