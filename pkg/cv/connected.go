package cv

import "jig/pkg/puzzle"

// FilterLargestComponent retains only the largest connected 8-connected component in the mask,
// completely wiping out small dust, dots, and speckle noise!
func FilterLargestComponent(mask *BinaryMask) *BinaryMask {
	w, h := mask.Width, mask.Height
	visited := make([]bool, w*h)

	type Point struct{ x, y int }

	var largestComponent []Point
	dx := []int{-1, 0, 1, -1, 1, -1, 0, 1}
	dy := []int{-1, -1, -1, 0, 0, 1, 1, 1}

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			idx := y*w + x
			if !mask.Data[idx] || visited[idx] {
				continue
			}

			// Flood fill (BFS)
			var currentComponent []Point
			queue := []Point{{x, y}}
			visited[idx] = true

			for len(queue) > 0 {
				p := queue[0]
				queue = queue[1:]
				currentComponent = append(currentComponent, p)

				for i := 0; i < 8; i++ {
					nx := p.x + dx[i]
					ny := p.y + dy[i]
					if nx >= 0 && nx < w && ny >= 0 && ny < h {
						nIdx := ny*w + nx
						if mask.Data[nIdx] && !visited[nIdx] {
							visited[nIdx] = true
							queue = append(queue, Point{nx, ny})
						}
					}
				}
			}

			if len(currentComponent) > len(largestComponent) {
				largestComponent = currentComponent
			}
		}
	}

	cleanMask := &BinaryMask{
		Width:  w,
		Height: h,
		Data:   make([]bool, w*h),
	}

	for _, p := range largestComponent {
		cleanMask.Set(p.x, p.y, true)
	}

	return cleanMask
}

// FillMaskHoles fills enclosed background holes (e.g. over-exposed highlight glare spots)
// by finding all background pixels connected to the image border and inverting unreachable background.
func FillMaskHoles(mask *BinaryMask) *BinaryMask {
	w, h := mask.Width, mask.Height
	isBorderBg := make([]bool, w*h)
	type Point struct{ x, y int }
	var queue []Point

	// Seed queue with all background pixels on the image 4 borders
	for x := 0; x < w; x++ {
		// Top border
		if !mask.Get(x, 0) {
			isBorderBg[x] = true
			queue = append(queue, Point{x, 0})
		}
		// Bottom border
		bottomIdx := (h - 1) * w + x
		if !mask.Get(x, h-1) && !isBorderBg[bottomIdx] {
			isBorderBg[bottomIdx] = true
			queue = append(queue, Point{x, h - 1})
		}
	}
	for y := 0; y < h; y++ {
		// Left border
		leftIdx := y * w
		if !mask.Get(0, y) && !isBorderBg[leftIdx] {
			isBorderBg[leftIdx] = true
			queue = append(queue, Point{0, y})
		}
		// Right border
		rightIdx := y*w + (w - 1)
		if !mask.Get(w-1, y) && !isBorderBg[rightIdx] {
			isBorderBg[rightIdx] = true
			queue = append(queue, Point{w - 1, y})
		}
	}

	// 4-connected BFS for outside background
	dx := []int{0, 0, -1, 1}
	dy := []int{-1, 1, 0, 0}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]

		for i := 0; i < 4; i++ {
			nx := p.x + dx[i]
			ny := p.y + dy[i]
			if nx >= 0 && nx < w && ny >= 0 && ny < h {
				nIdx := ny*w + nx
				if !mask.Data[nIdx] && !isBorderBg[nIdx] {
					isBorderBg[nIdx] = true
					queue = append(queue, Point{nx, ny})
				}
			}
		}
	}

	// Any pixel that is NOT connected to the outer border background belongs to the piece!
	filled := &BinaryMask{
		Width:  w,
		Height: h,
		Data:   make([]bool, w*h),
	}
	for i := 0; i < w*h; i++ {
		filled.Data[i] = !isBorderBg[i]
	}
	return filled
}

// TraceLargestContourWithFilter cleans the mask of small background dots and fills glare holes before tracing.
func TraceLargestContourWithFilter(mask *BinaryMask) []puzzle.Point2D {
	clean := FilterLargestComponent(mask)
	filled := FillMaskHoles(clean)
	return TraceLargestContour(filled)
}
