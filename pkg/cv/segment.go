package cv

import (
	"errors"
	"image"
	"image/color"
	"jig/pkg/generator"
	"jig/pkg/matcher"
	"jig/pkg/puzzle"
	"math"
	"sort"
)

// ProcessedPhysicalPiece contains full segmentation results and geometric telemetry for a physical piece.
type ProcessedPhysicalPiece struct {
	Piece          *puzzle.Piece      `json:"piece"`
	FullContour    []puzzle.Point2D   `json:"full_contour"`
	RawContour     []puzzle.Point2D   `json:"raw_contour"`
	CornerIndices  [4]int             `json:"corner_indices"`
	CornerPoints   [4]puzzle.Point2D  `json:"corner_points"`
	CornerAngles   [4]float64         `json:"corner_angles"` // Interior angles in degrees
	Centroid       puzzle.Point2D     `json:"centroid"`
	EdgeTypes      [4]puzzle.EdgeType `json:"edge_types"`
	EdgeTelemetry  [4]EdgeTelemetry   `json:"edge_telemetry"`
	Perimeter      float64            `json:"perimeter"`
	Area           float64            `json:"area"`
	ThresholdUsed  uint8              `json:"threshold_used"`
	InvertBgUsed   bool               `json:"invert_bg_used"`
	ThresholdMask  *image.Alpha       `json:"-"`
}

// OrderCornersClockwiseFromTopLeft rotates 4 corner indices so corner 0 is Top-Left (min X+Y) and order is clockwise.
func OrderCornersClockwiseFromTopLeft(corners [4]int, contour []puzzle.Point2D) [4]int {
	n := len(contour)
	// First ensure corners are sorted in contour index order
	sort.Ints(corners[:])

	// Check winding of corners
	signedArea := 0.0
	for i := 0; i < 4; i++ {
		p1 := contour[corners[i]]
		p2 := contour[corners[(i+1)%4]]
		signedArea += p1.X*p2.Y - p2.X*p1.Y
	}
	// In screen coordinates (Y down), clockwise has signedArea > 0
	if signedArea < 0 {
		corners[1], corners[3] = corners[3], corners[1]
	}

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
	_ = n
	return ordered
}

// SegmentPiece ingests a raw camera crop and extracts a segmented puzzle piece with classified edges and telemetry.
// If threshold == 0, Otsu's adaptive bimodal thresholding is automatically applied.
func SegmentPiece(rawImg image.Image, threshold uint8, invertBg bool) (*ProcessedPhysicalPiece, error) {
	if rawImg == nil {
		return nil, errors.New("raw image is nil")
	}

	usedThreshold := threshold
	usedInvert := invertBg
	if usedThreshold == 0 {
		otsuThresh, suggestInvert := CalculateOtsuThreshold(rawImg)
		usedThreshold = otsuThresh
		usedInvert = suggestInvert
	}

	// 1. Threshold image
	bMask := ThresholdImage(rawImg, usedThreshold, usedInvert)

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
	var cornerAngles [4]float64
	n := len(contour)
	k := 6 // tangent offset for corner angle

	for i := 0; i < 4; i++ {
		cIdx := corners[i]
		cornerPts[i] = contour[cIdx]

		pPrev := contour[(cIdx-k+n)%n]
		pCurr := contour[cIdx]
		pNext := contour[(cIdx+k)%n]

		v1 := puzzle.Point2D{X: pPrev.X - pCurr.X, Y: pPrev.Y - pCurr.Y}
		v2 := puzzle.Point2D{X: pNext.X - pCurr.X, Y: pNext.Y - pCurr.Y}
		l1 := math.Hypot(v1.X, v1.Y)
		l2 := math.Hypot(v2.X, v2.Y)
		if l1 > 0 && l2 > 0 {
			dot := (v1.X*v2.X + v1.Y*v2.Y) / (l1 * l2)
			dot = math.Max(-1.0, math.Min(1.0, dot))
			cornerAngles[i] = math.Acos(dot) * 180.0 / math.Pi
		} else {
			cornerAngles[i] = 90.0
		}
	}

	// 5. Partition into 4 edges and compute deep telemetry
	edgePolylines := SplitContourIntoEdges(contour, corners)
	var edgeTypes [4]puzzle.EdgeType
	var edgeTelemetry [4]EdgeTelemetry

	for i := 0; i < 4; i++ {
		edgeTypes[i], edgeTelemetry[i] = ClassifyEdgeWithTelemetry(edgePolylines[i])
	}

	// Calculate polygon perimeter and area (Shoelace formula)
	perimeter := 0.0
	area := 0.0
	for i := 0; i < n; i++ {
		p1 := contour[i]
		p2 := contour[(i+1)%n]
		perimeter += p1.DistanceTo(p2)
		area += p1.X*p2.Y - p2.X*p1.Y
	}
	area = math.Abs(area) * 0.5

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

	// Preview alpha mask using cleaned and hole-filled mask
	filledMask := FillMaskHoles(FilterLargestComponent(bMask))
	previewMask := image.NewAlpha(rawImg.Bounds())
	for y := 0; y < filledMask.Height; y++ {
		for x := 0; x < filledMask.Width; x++ {
			if filledMask.Get(x, y) {
				previewMask.SetAlpha(rawImg.Bounds().Min.X+x, rawImg.Bounds().Min.Y+y, color.Alpha{A: 255})
			}
		}
	}

	return &ProcessedPhysicalPiece{
		Piece:          piece,
		FullContour:    contour,
		RawContour:     rawContour,
		CornerIndices:  corners,
		CornerPoints:   cornerPts,
		CornerAngles:   cornerAngles,
		Centroid:       ComputeCentroid(contour),
		EdgeTypes:      edgeTypes,
		EdgeTelemetry:  edgeTelemetry,
		Perimeter:      perimeter,
		Area:           area,
		ThresholdUsed:  usedThreshold,
		InvertBgUsed:   usedInvert,
		ThresholdMask:  previewMask,
	}, nil
}
