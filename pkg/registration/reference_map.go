package registration

import (
	"image"
	"jig/pkg/puzzle"
	"sort"
)

// GridLocationCandidate ranks a potential (row, col) match on the reference image.
type GridLocationCandidate struct {
	Row      int
	Col      int
	Distance float64 // [0, 1], lower is closer visual match
}

// ReferenceMap indexes a master reference image (e.g. Starry Night) into an R x C grid of descriptors.
type ReferenceMap struct {
	Grid        puzzle.Grid
	Tiles       [][][]FeatureDescriptor // [row][col][rotationIndex: 0=0, 1=90, 2=180, 3=270]
	TileWidth   float64
	TileHeight  float64
	MasterImage image.Image
}

// NewReferenceMap partitions masterImg into an R x C grid and precomputes multi-rotation feature descriptors.
func NewReferenceMap(masterImg image.Image, grid puzzle.Grid) *ReferenceMap {
	b := masterImg.Bounds()
	w := b.Dx()
	h := b.Dy()

	cellW := float64(w) / float64(grid.Cols)
	cellH := float64(h) / float64(grid.Rows)

	tiles := make([][][]FeatureDescriptor, grid.Rows)
	for r := 0; r < grid.Rows; r++ {
		tiles[r] = make([][]FeatureDescriptor, grid.Cols)
		for c := 0; c < grid.Cols; c++ {
			x0 := int(float64(c) * cellW)
			y0 := int(float64(r) * cellH)
			x1 := int(float64(c+1) * cellW)
			y1 := int(float64(r+1) * cellH)

			rect := image.Rect(x0, y0, x1, y1)
			sub := subImage(masterImg, rect)

			// Rotations: 0, 90, 180, 270
			tiles[r][c] = make([]FeatureDescriptor, 4)
			tiles[r][c][0] = ExtractDescriptor(sub, nil)
			// For color moments and histograms, 90-degree rotations have identical color distribution!
			// We can share or replicate for orientation consistency:
			tiles[r][c][1] = tiles[r][c][0]
			tiles[r][c][2] = tiles[r][c][0]
			tiles[r][c][3] = tiles[r][c][0]
		}
	}

	return &ReferenceMap{
		Grid:        grid,
		Tiles:       tiles,
		TileWidth:   cellW,
		TileHeight:  cellH,
		MasterImage: masterImg,
	}
}

// LocateCandidates finds the top-K grid cells on the reference image that best match the given piece descriptor.
func (rm *ReferenceMap) LocateCandidates(desc FeatureDescriptor, topK int) []GridLocationCandidate {
	var candidates []GridLocationCandidate

	for r := 0; r < rm.Grid.Rows; r++ {
		for c := 0; c < rm.Grid.Cols; c++ {
			d := DescriptorDistance(desc, rm.Tiles[r][c][0])
			candidates = append(candidates, GridLocationCandidate{
				Row:      r,
				Col:      c,
				Distance: d,
			})
		}
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Distance < candidates[j].Distance
	})

	if topK > len(candidates) {
		topK = len(candidates)
	}
	return candidates[:topK]
}

// CellDistance returns the visual descriptor distance between a piece descriptor and grid tile (r, c).
func (rm *ReferenceMap) CellDistance(desc FeatureDescriptor, r, c int) float64 {
	if r < 0 || r >= rm.Grid.Rows || c < 0 || c >= rm.Grid.Cols {
		return 1.0
	}
	return DescriptorDistance(desc, rm.Tiles[r][c][0])
}

// Helper: subImage safely crops a rectangular region from an image.Image.
func subImage(src image.Image, rect image.Rectangle) image.Image {
	type subImager interface {
		SubImage(r image.Rectangle) image.Image
	}
	if si, ok := src.(subImager); ok {
		return si.SubImage(rect)
	}

	// Fallback copy
	dst := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			dst.Set(x-rect.Min.X, y-rect.Min.Y, src.At(x, y))
		}
	}
	return dst
}
