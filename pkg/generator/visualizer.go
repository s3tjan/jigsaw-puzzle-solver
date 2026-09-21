package generator

import (
	"image"
	"image/color"
	"image/draw"
	"jig/pkg/puzzle"
)

// RenderPuzzle renders pieces back onto a canvas.
// If explodedGap > 0, an exploded grid is drawn with space between pieces.
func RenderPuzzle(pieces []*puzzle.Piece, grid puzzle.Grid, explodedGap int) image.Image {
	if len(pieces) == 0 {
		return image.NewRGBA(image.Rect(0, 0, 100, 100))
	}

	// Compute cell dimensions from pieces
	maxW, maxH := 0, 0
	for _, p := range pieces {
		if p.Bounds.Dx() > maxW {
			maxW = p.Bounds.Dx()
		}
		if p.Bounds.Dy() > maxH {
			maxH = p.Bounds.Dy()
		}
	}

	canvasW := grid.Cols*maxW + (grid.Cols+1)*explodedGap
	canvasH := grid.Rows*maxH + (grid.Rows+1)*explodedGap

	dst := image.NewRGBA(image.Rect(0, 0, canvasW, canvasH))
	// Fill background with dark grey
	draw.Draw(dst, dst.Bounds(), &image.Uniform{color.RGBA{30, 32, 40, 255}}, image.Point{}, draw.Src)

	for _, p := range pieces {
		if p.Image == nil {
			continue
		}
		r := p.OriginalRow
		c := p.OriginalCol

		// Target position on canvas
		posX := explodedGap + c*(maxW+explodedGap)
		posY := explodedGap + r*(maxH+explodedGap)

		targetRect := image.Rect(posX, posY, posX+p.Image.Bounds().Dx(), posY+p.Image.Bounds().Dy())
		draw.Draw(dst, targetRect, p.Image, image.Point{}, draw.Over)
	}

	return dst
}
