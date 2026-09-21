package registration_test

import (
	"image"
	"image/color"
	"jig/pkg/puzzle"
	"jig/pkg/registration"
	"testing"
)

// createPatternImage creates an image with 4 distinct color quadrants:
// Top-Left: Red, Top-Right: Green, Bottom-Left: Blue, Bottom-Right: Yellow
func createPatternImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	halfW, halfH := w/2, h/2
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var c color.RGBA
			if x < halfW && y < halfH {
				c = color.RGBA{R: 255, G: 0, B: 0, A: 255} // Red
			} else if x >= halfW && y < halfH {
				c = color.RGBA{R: 0, G: 255, B: 0, A: 255} // Green
			} else if x < halfW && y >= halfH {
				c = color.RGBA{R: 0, G: 0, B: 255, A: 255} // Blue
			} else {
				c = color.RGBA{R: 255, G: 255, B: 0, A: 255} // Yellow
			}
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func TestDescriptorExtractionAndDistance(t *testing.T) {
	redImg := image.NewRGBA(image.Rect(0, 0, 50, 50))
	blueImg := image.NewRGBA(image.Rect(0, 0, 50, 50))

	for y := 0; y < 50; y++ {
		for x := 0; x < 50; x++ {
			redImg.SetRGBA(x, y, color.RGBA{R: 250, G: 10, B: 10, A: 255})
			blueImg.SetRGBA(x, y, color.RGBA{R: 10, G: 10, B: 250, A: 255})
		}
	}

	dRed := registration.ExtractDescriptor(redImg, nil)
	dBlue := registration.ExtractDescriptor(blueImg, nil)

	// Self distance should be 0.0
	selfDist := registration.DescriptorDistance(dRed, dRed)
	if selfDist > 0.01 {
		t.Errorf("expected self distance near 0, got %f", selfDist)
	}

	// Red vs Blue should have high distance (> 0.5)
	dist := registration.DescriptorDistance(dRed, dBlue)
	if dist < 0.5 {
		t.Errorf("expected high distance between red and blue, got %f", dist)
	}
}

func TestReferenceMapLocate(t *testing.T) {
	master := createPatternImage(200, 200)
	grid := puzzle.Grid{Rows: 2, Cols: 2}

	refMap := registration.NewReferenceMap(master, grid)

	// Piece from Bottom-Left (Blue: row 1, col 0)
	bluePiece := image.NewRGBA(image.Rect(0, 0, 80, 80))
	for y := 0; y < 80; y++ {
		for x := 0; x < 80; x++ {
			bluePiece.SetRGBA(x, y, color.RGBA{R: 0, G: 0, B: 255, A: 255})
		}
	}

	desc := registration.ExtractDescriptor(bluePiece, nil)
	candidates := refMap.LocateCandidates(desc, 1)

	if len(candidates) == 0 {
		t.Fatalf("expected at least 1 candidate")
	}

	best := candidates[0]
	if best.Row != 1 || best.Col != 0 {
		t.Errorf("expected best match at (1, 0), got (%d, %d) with dist %f",
			best.Row, best.Col, best.Distance)
	}
}
