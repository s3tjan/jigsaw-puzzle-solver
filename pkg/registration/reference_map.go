package registration

import (
	"image"
	"jig/pkg/puzzle"
	"sort"
)

// GridLocationCandidate ranks a potential (row, col) match on the reference image with rotation advice.
type GridLocationCandidate struct {
	Row            int          `json:"row"`
	Col            int          `json:"col"`
	Distance       float64      `json:"distance"`        // [0, 1], lower is closer visual match
	Rotation       int          `json:"rotation"`        // 0, 90, 180, 270 degrees CW piece should be rotated
	CandidateImage string       `json:"candidate_image"` // Base64 PNG crop of artwork at this location
	Metrics        MatchMetrics `json:"metrics"`         // Breakdown: Hue, Chroma, Gradient similarities
}

// ReferenceMap indexes a master reference image (e.g. Starry Night) into an R x C grid of descriptors.
type ReferenceMap struct {
	Grid        puzzle.Grid
	Tiles       [][][]FeatureDescriptor // [row][col][rotationIndex: 0..3]
	TileWidth   float64
	TileHeight  float64
	MasterImage image.Image
}

// rotateImage90CW rotates an RGBA/generic image 90 degrees clockwise.
func rotateImage90CW(src image.Image) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, h, w))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			dst.Set(h-1-y, x, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
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

			tiles[r][c] = make([]FeatureDescriptor, 4)
			// Rot 0
			tiles[r][c][0] = ExtractDescriptor(sub, nil)
			// Rot 90 CW
			r90 := rotateImage90CW(sub)
			tiles[r][c][1] = ExtractDescriptor(r90, nil)
			// Rot 180 CW
			r180 := rotateImage90CW(r90)
			tiles[r][c][2] = ExtractDescriptor(r180, nil)
			// Rot 270 CW
			r270 := rotateImage90CW(r180)
			tiles[r][c][3] = ExtractDescriptor(r270, nil)
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
	return rm.LocateCandidatesWithTopology(desc, -1, topK)
}

// LocateCandidatesWithTopology filters candidate slots by physical edge topology and tests all 4 rotations.
// flatCount == 2 -> Corners only
// flatCount == 1 -> Borders only (excluding corners)
// flatCount == 0 -> Interior only
// flatCount < 0  -> No topological filter (searches everywhere)
func (rm *ReferenceMap) LocateCandidatesWithTopology(desc FeatureDescriptor, flatCount int, topK int) []GridLocationCandidate {
	var candidates []GridLocationCandidate
	rotations := []int{0, 90, 180, 270}

	for r := 0; r < rm.Grid.Rows; r++ {
		for c := 0; c < rm.Grid.Cols; c++ {
			// Apply topology constraints if known
			if flatCount >= 0 {
				isCorner := rm.Grid.IsCorner(r, c)
				isBorder := rm.Grid.IsBorder(r, c)

				if flatCount == 2 && !isCorner {
					continue // Corner piece must go to corner
				}
				if flatCount == 1 && (!isBorder || isCorner) {
					continue // Border piece must go to non-corner border
				}
				if flatCount == 0 && isBorder {
					continue // Interior piece cannot go to border/corner
				}
			}

			// Test all 4 orientations to find the minimum distance and optimal rotation
			bestDist := 1.0
			bestRot := 0
			var bestMetrics MatchMetrics

			for rotIdx, deg := range rotations {
				// Comparing scanned piece with tile rotated by (360-deg)%360 determines
				// how much the user should rotate the physical piece clockwise.
				tileDesc := rm.Tiles[r][c][rotIdx]
				d, metrics := DescriptorDistanceDetailed(desc, tileDesc)
				if d < bestDist {
					bestDist = d
					bestRot = deg
					bestMetrics = metrics
				}
			}

			candidates = append(candidates, GridLocationCandidate{
				Row:      r,
				Col:      c,
				Distance: bestDist,
				Rotation: bestRot,
				Metrics:  bestMetrics,
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

// GetTileCrop returns a high-resolution crop of the master artwork centered around (r, c) with optional padding margin.
func (rm *ReferenceMap) GetTileCrop(r, c int, marginPixels int) image.Image {
	if rm.MasterImage == nil {
		return nil
	}
	b := rm.MasterImage.Bounds()
	x0 := int(float64(c)*rm.TileWidth) - marginPixels
	y0 := int(float64(r)*rm.TileHeight) - marginPixels
	x1 := int(float64(c+1)*rm.TileWidth) + marginPixels
	y1 := int(float64(r+1)*rm.TileHeight) + marginPixels

	if x0 < b.Min.X {
		x0 = b.Min.X
	}
	if y0 < b.Min.Y {
		y0 = b.Min.Y
	}
	if x1 > b.Max.X {
		x1 = b.Max.X
	}
	if y1 > b.Max.Y {
		y1 = b.Max.Y
	}

	return subImage(rm.MasterImage, image.Rect(x0, y0, x1, y1))
}

// CellDistance returns visual distance between piece descriptor and grid tile (r, c).
func (rm *ReferenceMap) CellDistance(desc FeatureDescriptor, r, c int) float64 {
	if r < 0 || r >= rm.Grid.Rows || c < 0 || c >= rm.Grid.Cols {
		return 1.0
	}
	return DescriptorDistance(desc, rm.Tiles[r][c][0])
}

func subImage(src image.Image, rect image.Rectangle) image.Image {
	type subImager interface {
		SubImage(r image.Rectangle) image.Image
	}
	if si, ok := src.(subImager); ok {
		return si.SubImage(rect)
	}

	dst := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			dst.Set(x-rect.Min.X, y-rect.Min.Y, src.At(x, y))
		}
	}
	return dst
}
