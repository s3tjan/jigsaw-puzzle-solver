package main

import (
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"

	"jig/pkg/generator"
	"jig/pkg/puzzle"
)

// createSyntheticArtwork generates a rich, stylized test image reminiscent of colorful brushstrokes.
func createSyntheticArtwork(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			fx := float64(x) / float64(w)
			fy := float64(y) / float64(h)

			// Swirl-like patterns reminiscent of Starry Night
			swirl := math.Sin(fx*12.0+fy*8.0) * math.Cos(fy*15.0-fx*5.0)
			r := uint8(math.Min(255, math.Max(0, (0.2+0.8*fx+0.2*swirl)*255)))
			g := uint8(math.Min(255, math.Max(0, (0.3+0.7*fy+0.3*swirl)*255)))
			b := uint8(math.Min(255, math.Max(0, (0.6+0.4*(1.0-fx)-0.2*swirl)*255)))

			img.SetRGBA(x, y, color.RGBA{R: r, G: g, B: b, A: 255})
		}
	}
	return img
}

func main() {
	inputPath := flag.String("input", "", "Optional input image file (PNG/JPEG). If empty, generates synthetic artwork.")
	rows := flag.Int("rows", 4, "Number of grid rows")
	cols := flag.Int("cols", 5, "Number of grid columns")
	outDir := flag.String("out", "output", "Output directory for pieces and visualization")
	gap := flag.Int("gap", 16, "Exploded view gap size in pixels")
	flag.Parse()

	if err := os.MkdirAll(*outDir, 0755); err != nil {
		log.Fatalf("Failed to create output dir: %v", err)
	}

	var baseImg image.Image
	if *inputPath != "" {
		f, err := os.Open(*inputPath)
		if err != nil {
			log.Fatalf("Failed to open input image: %v", err)
		}
		defer f.Close()

		baseImg, _, err = image.Decode(f)
		if err != nil {
			log.Fatalf("Failed to decode input image: %v", err)
		}
		fmt.Printf("Loaded image %s (%dx%d)\n", *inputPath, baseImg.Bounds().Dx(), baseImg.Bounds().Dy())
	} else {
		fmt.Printf("No input image specified; generating synthetic artwork (%dx%d)\n", 800, 600)
		baseImg = createSyntheticArtwork(800, 600)
	}

	cfg := generator.DefaultCutterConfig(*rows, *cols)
	fmt.Printf("Cutting puzzle into %d x %d (%d pieces)...\n", *rows, *cols, *rows**cols)

	res, err := generator.CutPuzzle(baseImg, cfg)
	if err != nil {
		log.Fatalf("Error cutting puzzle: %v", err)
	}

	// Classify pieces summary
	corners, borders, interiors := 0, 0, 0
	for _, p := range res.Pieces {
		switch p.Classification() {
		case puzzle.ClassCorner:
			corners++
		case puzzle.ClassBorder:
			borders++
		case puzzle.ClassInterior:
			interiors++
		}
	}

	fmt.Printf("Generated %d pieces: %d corners, %d borders, %d interior pieces.\n",
		len(res.Pieces), corners, borders, interiors)

	// Export exploded puzzle rendering
	explodedImg := generator.RenderPuzzle(res.Pieces, res.Grid, *gap)
	explodedFile := filepath.Join(*outDir, "exploded_puzzle.png")
	fOut, err := os.Create(explodedFile)
	if err != nil {
		log.Fatalf("Failed to create exploded image file: %v", err)
	}
	defer fOut.Close()

	if err := png.Encode(fOut, explodedImg); err != nil {
		log.Fatalf("Failed to encode exploded image: %v", err)
	}
	fmt.Printf("Saved exploded puzzle preview to: %s\n", explodedFile)

	// Save a few sample pieces as individual PNGs
	piecesSubdir := filepath.Join(*outDir, "sample_pieces")
	_ = os.MkdirAll(piecesSubdir, 0755)
	sampleCount := 6
	if len(res.Pieces) < sampleCount {
		sampleCount = len(res.Pieces)
	}
	for i := 0; i < sampleCount; i++ {
		p := res.Pieces[i]
		piecePath := filepath.Join(piecesSubdir, fmt.Sprintf("piece_%d_r%d_c%d_%s.png",
			p.ID, p.OriginalRow, p.OriginalCol, p.Classification()))
		pf, err := os.Create(piecePath)
		if err == nil {
			_ = png.Encode(pf, p.Image)
			pf.Close()
		}
	}
	fmt.Printf("Exported %d sample individual pieces to: %s\n", sampleCount, piecesSubdir)
}

func suppressJpegImport() {
	_ = jpeg.DefaultQuality
}
