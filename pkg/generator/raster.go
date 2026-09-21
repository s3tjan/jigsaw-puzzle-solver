package generator

import (
	"image"
	"image/color"
	"jig/pkg/puzzle"
	"math"
	"sort"
)

// PointInPolygon checks whether a point (x, y) is inside the polygon using the ray-casting algorithm.
func PointInPolygon(x, y float64, poly []puzzle.Point2D) bool {
	n := len(poly)
	if n < 3 {
		return false
	}
	inside := false
	j := n - 1
	for i := 0; i < n; i++ {
		pi := poly[i]
		pj := poly[j]
		if ((pi.Y > y) != (pj.Y > y)) &&
			(x < (pj.X-pi.X)*(y-pi.Y)/(pj.Y-pi.Y)+pi.X) {
			inside = !inside
		}
		j = i
	}
	return inside
}

// BoundingBox computes the bounding integer rectangle for a polygon.
func BoundingBox(poly []puzzle.Point2D) image.Rectangle {
	if len(poly) == 0 {
		return image.Rectangle{}
	}
	minX, minY := poly[0].X, poly[0].Y
	maxX, maxY := poly[0].X, poly[0].Y
	for _, p := range poly[1:] {
		if p.X < minX {
			minX = p.X
		}
		if p.X > maxX {
			maxX = p.X
		}
		if p.Y < minY {
			minY = p.Y
		}
		if p.Y > maxY {
			maxY = p.Y
		}
	}
	return image.Rect(
		int(math.Floor(minX)),
		int(math.Floor(minY)),
		int(math.Ceil(maxX))+1,
		int(math.Ceil(maxY))+1,
	)
}

// RasterizePolygonMask builds an *image.Alpha mask for a polygon within the specified bounds.
// Uses scanline intersection for high performance.
func RasterizePolygonMask(poly []puzzle.Point2D, bounds image.Rectangle) *image.Alpha {
	mask := image.NewAlpha(bounds)
	n := len(poly)
	if n < 3 {
		return mask
	}

	type EdgeSegment struct {
		yMin, yMax float64
		xMin       float64
		invSlope   float64
	}

	var edges []EdgeSegment
	for i := 0; i < n; i++ {
		p1 := poly[i]
		p2 := poly[(i+1)%n]
		if p1.Y == p2.Y {
			continue // Horizontal edge, ignore in scanline
		}
		var low, high puzzle.Point2D
		if p1.Y < p2.Y {
			low, high = p1, p2
		} else {
			low, high = p2, p1
		}
		invSlope := (high.X - low.X) / (high.Y - low.Y)
		edges = append(edges, EdgeSegment{
			yMin:     low.Y,
			yMax:     high.Y,
			xMin:     low.X,
			invSlope: invSlope,
		})
	}

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		scanY := float64(y) + 0.5
		var intersections []float64

		for _, e := range edges {
			if scanY >= e.yMin && scanY < e.yMax {
				x := e.xMin + (scanY-e.yMin)*e.invSlope
				intersections = append(intersections, x)
			}
		}

		if len(intersections) < 2 {
			continue
		}
		sort.Float64s(intersections)

		for i := 0; i < len(intersections)-1; i += 2 {
			xStart := int(math.Ceil(intersections[i]))
			xEnd := int(math.Floor(intersections[i+1]))

			if xStart < bounds.Min.X {
				xStart = bounds.Min.X
			}
			if xEnd >= bounds.Max.X {
				xEnd = bounds.Max.X - 1
			}

			for x := xStart; x <= xEnd; x++ {
				mask.SetAlpha(x, y, color.Alpha{A: 255})
			}
		}
	}

	return mask
}

// ExtractPieceImage creates an RGBA image of the piece bounded by the polygon.
func ExtractPieceImage(src image.Image, poly []puzzle.Point2D) (image.Image, *image.Alpha, image.Rectangle) {
	bounds := BoundingBox(poly)
	// Intersect with source bounds
	intersectBounds := bounds.Intersect(src.Bounds())
	mask := RasterizePolygonMask(poly, bounds)

	pieceImg := image.NewRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))

	for y := intersectBounds.Min.Y; y < intersectBounds.Max.Y; y++ {
		for x := intersectBounds.Min.X; x < intersectBounds.Max.X; x++ {
			a := mask.AlphaAt(x, y).A
			if a > 0 {
				c := src.At(x, y)
				r, g, b, _ := c.RGBA()
				localX := x - bounds.Min.X
				localY := y - bounds.Min.Y
				pieceImg.SetRGBA(localX, localY, color.RGBA{
					R: uint8(r >> 8),
					G: uint8(g >> 8),
					B: uint8(b >> 8),
					A: a,
				})
			}
		}
	}

	return pieceImg, mask, bounds
}
