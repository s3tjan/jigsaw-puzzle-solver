package cv

import (
	"errors"
	"image"
	"image/color"
	"jig/pkg/generator"
	"jig/pkg/matcher"
	"jig/pkg/puzzle"
	"math"
)

// ProcessedPhysicalPiece contains full segmentation results for a physical piece.
type ProcessedPhysicalPiece struct {
	Piece         *puzzle.Piece      `json:"piece"`
	FullContour   []puzzle.Point2D   `json:"full_contour"`
	CornerIndices [4]int             `json:"corner_indices"`
	CornerPoints  [4]puzzle.Point2D  `json:"corner_points"`
	Centroid      puzzle.Point2D     `json:"centroid"`
	EdgeTypes     [4]puzzle.EdgeType `json:"edge_types"`
	ThresholdMask *image.Alpha       `json:"-"`
}

// OrderCornersClockwiseFromTopLeft rotates 4 corner indices so corner 0 is Top-Left (min X+Y)
func OrderCornersClockwiseFromTopLeft(corners [4]int, contour []puzzle.Point2D) [4]int {
	bestIdx := 0
	minSum := math.MaxFloat64

	for i := 0; i < 4; i++ {
		p := contour[corners[i]]
		sum := p.X + p.Y
		if sum < minSum {
			minSum = sum
			bestIdx = i
		}
	}

	var ordered [4]int
	for i := 0; i < 4; i++ {
		ordered[i] = corners[(bestIdx+i)%4]
	}
	return ordered
}

// SegmentPiece ingests a raw camera crop and extracts a segmented puzzle piece with classified edges.
func SegmentPiece(rawImg image.Image, threshold uint8, invertBg bool) (*ProcessedPhysicalPiece, error) {
	if rawImg == nil {
		return nil, errors.New("raw image is nil")
	}

	// 1. Threshold image
	bMask := ThresholdImage(rawImg, threshold, invertBg)

	// 2. Trace largest boundary contour
	rawContour := TraceLargestContourWithFilter(bMask)
	if len(rawContour) < 30 {
		return nil, errors.New("no clear piece contour found in frame")
	}

	// 3. Smooth & resample contour to 160 equidistant perimeter points
	smoothed := SmoothContour(rawContour, 5)
	contour := ResampleContour(smoothed, 160)

	// 4. Detect 4 physical corners
	corners, err := DetectCorners(contour)
	if err != nil {
		return nil, err
	}

	// Reorder corners so corner 0 is Top-Left:
	// Edge 0: Top-Left -> Top-Right (Top)
	// Edge 1: Top-Right -> Bottom-Right (Right)
	// Edge 2: Bottom-Right -> Bottom-Left (Bottom)
	// Edge 3: Bottom-Left -> Top-Left (Left)
	corners = OrderCornersClockwiseFromTopLeft(corners, contour)

	var cornerPts [4]puzzle.Point2D
	for i := 0; i < 4; i++ {
		cornerPts[i] = contour[corners[i]]
	}

	// 5. Partition into 4 edges and classify
	edgePolylines := SplitContourIntoEdges(contour, corners)
	var edgeTypes [4]puzzle.EdgeType
	for i := 0; i < 4; i++ {
		edgeTypes[i] = ClassifyEdgeShape(edgePolylines[i])
	}

	// 6. Extract piece image & alpha mask using rasterizer
	pieceImg, mask, bounds := generator.ExtractPieceImage(rawImg, contour)

	// 7. Extract edge boundary colors
	edges := [4]puzzle.Edge{
		{Dir: puzzle.Top, Type: edgeTypes[0], Points: edgePolylines[0], Colors: matcher.ExtractEdgeBoundaryColors(rawImg, edgePolylines[0])},
		{Dir: puzzle.Right, Type: edgeTypes[1], Points: edgePolylines[1], Colors: matcher.ExtractEdgeBoundaryColors(rawImg, edgePolylines[1])},
		{Dir: puzzle.Bottom, Type: edgeTypes[2], Points: edgePolylines[2], Colors: matcher.ExtractEdgeBoundaryColors(rawImg, edgePolylines[2])},
		{Dir: puzzle.Left, Type: edgeTypes[3], Points: edgePolylines[3], Colors: matcher.ExtractEdgeBoundaryColors(rawImg, edgePolylines[3])},
	}

	piece := &puzzle.Piece{
		ID:       -1,
		Edges:    edges,
		Rotation: 0,
		Image:    pieceImg,
		Mask:     mask,
		Bounds:   bounds,
	}

	// Preview alpha mask
	previewMask := image.NewAlpha(rawImg.Bounds())
	for y := 0; y < bMask.Height; y++ {
		for x := 0; x < bMask.Width; x++ {
			if bMask.Get(x, y) {
				previewMask.SetAlpha(rawImg.Bounds().Min.X+x, rawImg.Bounds().Min.Y+y, color.Alpha{A: 255})
			}
		}
	}

	return &ProcessedPhysicalPiece{
		Piece:         piece,
		FullContour:   contour,
		CornerIndices: corners,
		CornerPoints:  cornerPts,
		Centroid:      ComputeCentroid(contour),
		EdgeTypes:     edgeTypes,
		ThresholdMask: previewMask,
	}, nil
}
