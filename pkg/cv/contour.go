package cv

import (
	"image"
	"jig/pkg/puzzle"
	"math"
)

// BinaryMask holds a 1-bit boolean mask of foreground pixels.
type BinaryMask struct {
	Width  int
	Height int
	Data   []bool
}

func (m *BinaryMask) Get(x, y int) bool {
	if x < 0 || x >= m.Width || y < 0 || y >= m.Height {
		return false
	}
	return m.Data[y*m.Width+x]
}

func (m *BinaryMask) Set(x, y int, val bool) {
	if x >= 0 && x < m.Width && y >= 0 && y < m.Height {
		m.Data[y*m.Width+x] = val
	}
}

// ThresholdImage converts an RGBA/RGB image to a BinaryMask based on grayscale luminance.
// If invert is true, pixels darker than threshold are considered foreground (for light backgrounds).
// If invert is false, pixels brighter than threshold are foreground (for dark backgrounds).
func ThresholdImage(img image.Image, threshold uint8, invert bool) *BinaryMask {
	b := img.Bounds()
	w := b.Dx()
	h := b.Dy()
	mask := &BinaryMask{
		Width:  w,
		Height: h,
		Data:   make([]bool, w*h),
	}

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, bVal, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			if a == 0 {
				continue
			}
			// Grayscale luminance (ITU-R BT.601)
			lum := uint8((299*(r>>8) + 587*(g>>8) + 114*(bVal>>8)) / 1000)

			isForeground := false
			if invert {
				isForeground = lum < threshold
			} else {
				isForeground = lum > threshold
			}
			mask.Set(x, y, isForeground)
		}
	}

	return mask
}

// TraceLargestContour finds the outermost boundary of the largest connected foreground component
// using Moore-Neighbor boundary tracing algorithm.
func TraceLargestContour(mask *BinaryMask) []puzzle.Point2D {
	w, h := mask.Width, mask.Height

	// Find the top-most, left-most foreground pixel
	startX, startY := -1, -1
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if mask.Get(x, y) {
				startX = x
				startY = y
				break
			}
		}
		if startX != -1 {
			break
		}
	}

	if startX == -1 {
		return nil // No foreground found
	}

	// 8-connected neighborhood clockwise offsets starting from West:
	// 0: (-1, 0) W
	// 1: (-1, -1) NW
	// 2: (0, -1) N
	// 3: (1, -1) NE
	// 4: (1, 0) E
	// 5: (1, 1) SE
	// 6: (0, 1) S
	// 7: (-1, 1) SW
	dx := [8]int{-1, -1, 0, 1, 1, 1, 0, -1}
	dy := [8]int{0, -1, -1, -1, 0, 1, 1, 1}

	var contour []puzzle.Point2D
	currX, currY := startX, startY
	backDir := 0 // Backtrack pointer

	// Trace loop
	maxSteps := w * h
	for step := 0; step < maxSteps; step++ {
		contour = append(contour, puzzle.Point2D{X: float64(currX), Y: float64(currY)})

		// Scan 8-neighbors starting from backDir
		found := false
		nextX, nextY := currX, currY
		nextBackDir := 0

		for i := 0; i < 8; i++ {
			dir := (backDir + i) % 8
			nx := currX + dx[dir]
			ny := currY + dy[dir]

			if mask.Get(nx, ny) {
				nextX = nx
				nextY = ny
				// Set backtrack direction for next step: (dir + 4 - 2) % 8
				nextBackDir = (dir + 5) % 8
				found = true
				break
			}
		}

		if !found {
			break // Isolated single pixel
		}

		if nextX == startX && nextY == startY && step > 2 {
			break // Closed loop completed!
		}

		currX = nextX
		currY = nextY
		backDir = nextBackDir
	}

	return contour
}

// SmoothContour applies moving average window smoothing to remove pixel discretization staircase steps.
func SmoothContour(pts []puzzle.Point2D, windowSize int) []puzzle.Point2D {
	n := len(pts)
	if n < windowSize || windowSize < 2 {
		return pts
	}

	half := windowSize / 2
	smoothed := make([]puzzle.Point2D, n)

	for i := 0; i < n; i++ {
		var sumX, sumY float64
		count := 0
		for j := -half; j <= half; j++ {
			idx := (i + j + n) % n
			sumX += pts[idx].X
			sumY += pts[idx].Y
			count++
		}
		smoothed[i] = puzzle.Point2D{
			X: sumX / float64(count),
			Y: sumY / float64(count),
		}
	}

	return smoothed
}

// ResampleContour produces N uniformly-spaced points along the closed contour.
func ResampleContour(pts []puzzle.Point2D, targetPoints int) []puzzle.Point2D {
	n := len(pts)
	if n < 2 || targetPoints < 4 {
		return pts
	}

	// Compute cumulative perimeter distances
	dists := make([]float64, n+1)
	totalLen := 0.0
	for i := 0; i < n; i++ {
		p1 := pts[i]
		p2 := pts[(i+1)%n]
		segLen := math.Hypot(p2.X-p1.X, p2.Y-p1.Y)
		totalLen += segLen
		dists[i+1] = totalLen
	}

	if totalLen == 0 {
		return pts
	}

	resampled := make([]puzzle.Point2D, targetPoints)
	step := totalLen / float64(targetPoints)

	curSeg := 0
	for i := 0; i < targetPoints; i++ {
		targetDist := float64(i) * step

		for curSeg < n && dists[curSeg+1] < targetDist {
			curSeg++
		}
		if curSeg >= n {
			curSeg = n - 1
		}

		segStart := dists[curSeg]
		segLen := dists[curSeg+1] - segStart
		t := 0.0
		if segLen > 0 {
			t = (targetDist - segStart) / segLen
		}

		p1 := pts[curSeg]
		p2 := pts[(curSeg+1)%n]
		resampled[i] = puzzle.Point2D{
			X: p1.X + t*(p2.X-p1.X),
			Y: p1.Y + t*(p2.Y-p1.Y),
		}
	}

	return resampled
}
