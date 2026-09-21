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

// TraceLargestContourWithFilter cleans the mask of small background dots before tracing.
func TraceLargestContourWithFilter(mask *BinaryMask) []puzzle.Point2D {
	clean := FilterLargestComponent(mask)
	return TraceLargestContour(clean)
}
