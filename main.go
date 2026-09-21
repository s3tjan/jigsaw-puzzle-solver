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
	"math/rand"
	"os"
	"path/filepath"
	"time"

	"jig/pkg/generator"
	"jig/pkg/puzzle"
	"jig/pkg/solver"
)

// createSyntheticArtwork generates a rich, stylized artwork reminiscent of Starry Night.
func createSyntheticArtwork(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			fx := float64(x) / float64(w)
			fy := float64(y) / float64(h)

			// Swirl-like patterns
			swirl := math.Sin(fx*12.0+fy*8.0) * math.Cos(fy*15.0-fx*5.0)
			r := uint8(math.Min(255, math.Max(0, (0.15+0.85*fx+0.2*swirl)*255)))
			g := uint8(math.Min(255, math.Max(0, (0.25+0.75*fy+0.3*swirl)*255)))
			b := uint8(math.Min(255, math.Max(0, (0.55+0.45*(1.0-fx)-0.2*swirl)*255)))

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
	doSolve := flag.Bool("solve", true, "Automatically shuffle, rotate, and solve the cut puzzle")
	seed := flag.Int64("seed", 42, "Random seed for cutting and shuffling")
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
		fmt.Printf("Generating synthetic artwork canvas (800x600)...\n")
		baseImg = createSyntheticArtwork(800, 600)
	}

	cfg := generator.DefaultCutterConfig(*rows, *cols)
	cfg.Seed = *seed
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
	fmt.Printf("Pieces classified: %d corners, %d borders, %d interior pieces.\n",
		corners, borders, interiors)

	// Save exploded puzzle preview
	explodedImg := generator.RenderPuzzle(res.Pieces, res.Grid, *gap)
	explodedFile := filepath.Join(*outDir, "exploded_puzzle.png")
	if f, err := os.Create(explodedFile); err == nil {
		_ = png.Encode(f, explodedImg)
		f.Close()
		fmt.Printf("Saved exploded puzzle preview to: %s\n", explodedFile)
	}

	if !*doSolve {
		return
	}

	// Shuffling and rotating all pieces
	fmt.Println("\n--- Starting Solver Benchmark ---")
	rng := rand.New(rand.NewSource(*seed + 100))
	solver.ShuffleAndRotate(res.Pieces, rng)
	fmt.Printf("Shuffled and randomly rotated %d pieces.\n", len(res.Pieces))

	s := solver.NewSolver(res.Grid, res.Pieces, solver.DefaultSolverConfig())

	startTime := time.Now()
	solveRes, err := s.Solve()
	duration := time.Since(startTime)

	if err != nil {
		log.Fatalf("Solver failed: %v", err)
	}

	fmt.Printf("Solver completed in %v!\n", duration)
	fmt.Printf("Accuracy: %.1f%% (Global puzzle rotation: %d°)\n",
		solveRes.Accuracy, solveRes.GlobalRotation)

	// Reconstruct solved board into image
	gridPieces := make([][]*puzzle.Piece, *rows)
	for r := 0; r < *rows; r++ {
		gridPieces[r] = make([]*puzzle.Piece, *cols)
		for c := 0; c < *cols; c++ {
			p := solveRes.Board.At(r, c)
			if p != nil {
				gridPieces[r][c] = p.Piece
			}
		}
	}

	cellW := baseImg.Bounds().Dx() / *cols
	cellH := baseImg.Bounds().Dy() / *rows
	solvedImg := generator.RenderSolvedPieces(gridPieces, res.Grid, cellW, cellH)

	solvedFile := filepath.Join(*outDir, "solved_puzzle.png")
	if f, err := os.Create(solvedFile); err == nil {
		_ = png.Encode(f, solvedImg)
		f.Close()
		fmt.Printf("Saved solved puzzle reconstruction to: %s\n", solvedFile)
	}
}

func suppressJpeg() {
	_ = jpeg.DefaultQuality
}
