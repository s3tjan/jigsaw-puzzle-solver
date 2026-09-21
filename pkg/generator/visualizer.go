package generator

import (
	"image"
	"image/color"
	"image/draw"
	"jig/pkg/puzzle"
)

// PlacedPieceViewer interface avoids circular dependency with solver.
type PlacedPieceViewer interface {
	GetPiece() *puzzle.Piece
	GetRotation() int
}

// RenderPuzzle renders pieces back onto a canvas.
// If explodedGap > 0, an exploded grid is drawn with space between pieces.
func RenderPuzzle(pieces []*puzzle.Piece, grid puzzle.Grid, explodedGap int) image.Image {
	if len(pieces) == 0 {
		return image.NewRGBA(image.Rect(0, 0, 100, 100))
	}

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
	draw.Draw(dst, dst.Bounds(), &image.Uniform{color.RGBA{30, 32, 40, 255}}, image.Point{}, draw.Src)

	for _, p := range pieces {
		if p.Image == nil {
			continue
		}
		r := p.OriginalRow
		c := p.OriginalCol

		posX := explodedGap + c*(maxW+explodedGap)
		posY := explodedGap + r*(maxH+explodedGap)

		targetRect := image.Rect(posX, posY, posX+p.Image.Bounds().Dx(), posY+p.Image.Bounds().Dy())
		draw.Draw(dst, targetRect, p.Image, image.Point{}, draw.Over)
	}

	return dst
}

// RotateImage90CW rotates an RGBA image 90 degrees clockwise.
func RotateImage90CW(src image.Image) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, h, w))

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// (x, y) maps to (h - 1 - y, x)
			dst.Set(h-1-y, x, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}

// RotateImage rotates an RGBA image by 0, 90, 180, or 270 degrees clockwise.
func RotateImage(src image.Image, deg int) image.Image {
	deg = (deg%360 + 360) % 360
	res := src
	steps := deg / 90
	for i := 0; i < steps; i++ {
		res = RotateImage90CW(res)
	}
	return res
}

// RenderAssembledBoard renders a solved board back into an image.
type BoardLike interface {
	At(r, c int) interface {
		GetPiece() *puzzle.Piece
		GetRotation() int
	}
}

// RenderSolvedPieces renders a solved grid of pieces.
func RenderSolvedPieces(boardPieces [][]*puzzle.Piece, grid puzzle.Grid, cellW, cellH int) image.Image {
	canvasW := grid.Cols * cellW
	canvasH := grid.Rows * cellH
	dst := image.NewRGBA(image.Rect(0, 0, canvasW, canvasH))

	for r := 0; r < grid.Rows; r++ {
		for c := 0; c < grid.Cols; c++ {
			p := boardPieces[r][c]
			if p == nil || p.Image == nil {
				continue
			}
			targetRect := image.Rect(p.Bounds.Min.X, p.Bounds.Min.Y, p.Bounds.Max.X, p.Bounds.Max.Y)
			draw.Draw(dst, targetRect, p.Image, image.Point{}, draw.Over)
		}
	}
	return dst
}
