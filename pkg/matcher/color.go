package matcher

import (
	"image"
	"image/color"
	"jig/pkg/puzzle"
	"math"
)

// ColorDistance computes average RGB difference between boundary colors of two edges.
// When edges mate, color samples along edgeB run in reverse order relative to edgeA.
func ColorDistance(edgeA, edgeB puzzle.Edge) float64 {
	nA := len(edgeA.Colors)
	nB := len(edgeB.Colors)
	if nA == 0 || nB == 0 {
		return 0.0
	}

	samples := nA
	if nB < samples {
		samples = nB
	}
	if samples < 2 {
		return 0.0
	}

	totalDiff := 0.0
	for i := 0; i < samples; i++ {
		tA := float64(i) / float64(samples-1)
		tB := 1.0 - tA // reverse

		idxA := int(tA * float64(nA-1))
		idxB := int(tB * float64(nB-1))

		cA := edgeA.Colors[idxA]
		cB := edgeB.Colors[idxB]

		dr := float64(cA.R) - float64(cB.R)
		dg := float64(cA.G) - float64(cB.G)
		db := float64(cA.B) - float64(cB.B)

		diff := math.Sqrt(dr*dr + dg*dg + db*db)
		totalDiff += diff
	}

	return (totalDiff / float64(samples)) / 442.0
}

// ExtractEdgeBoundaryColors samples colors directly from src image along the edge polyline.
func ExtractEdgeBoundaryColors(src image.Image, points []puzzle.Point2D) []color.RGBA {
	if src == nil || len(points) == 0 {
		return nil
	}
	colors := make([]color.RGBA, len(points))
	bounds := src.Bounds()

	for i, pt := range points {
		ix := int(math.Round(pt.X))
		iy := int(math.Round(pt.Y))

		if ix < bounds.Min.X {
			ix = bounds.Min.X
		}
		if ix >= bounds.Max.X {
			ix = bounds.Max.X - 1
		}
		if iy < bounds.Min.Y {
			iy = bounds.Min.Y
		}
		if iy >= bounds.Max.Y {
			iy = bounds.Max.Y - 1
		}

		r, g, b, a := src.At(ix, iy).RGBA()
		colors[i] = color.RGBA{
			R: uint8(r >> 8),
			G: uint8(g >> 8),
			B: uint8(b >> 8),
			A: uint8(a >> 8),
		}
	}
	return colors
}
