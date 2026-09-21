package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"jig/pkg/generator"
	"jig/pkg/puzzle"
	"jig/pkg/cv"
	"jig/pkg/registration"
	"jig/pkg/solver"
)

// GenerateRequest payload for /api/puzzle/generate.
type GenerateRequest struct {
	Rows   int    `json:"rows"`
	Cols   int    `json:"cols"`
	Preset string `json:"preset"` // "starry_night", "gradient", "custom"
	Image  string `json:"image"`  // Base64 data URL if custom
	Seed   int64  `json:"seed"`
}

// PieceDTO serializable piece representation for frontend.
type PieceDTO struct {
	ID             int              `json:"id"`
	OriginalRow    int              `json:"original_row"`
	OriginalCol    int              `json:"original_col"`
	Classification string           `json:"classification"`
	Rotation       int              `json:"rotation"`
	Bounds         puzzle.Rectangle `json:"bounds"`
	Edges          [4]EdgeDTO       `json:"edges"`
	ImageBase64    string           `json:"image_base64"`
}

// EdgeDTO serializable edge info.
type EdgeDTO struct {
	Direction string           `json:"direction"`
	Type      string           `json:"type"`
	Points    []puzzle.Point2D `json:"points"`
}

// GenerateResponse returned to client.
type GenerateResponse struct {
	Grid         puzzle.Grid `json:"grid"`
	Pieces       []PieceDTO  `json:"pieces"`
	Width        int         `json:"width"`
	Height       int         `json:"height"`
	GenerationMs int64       `json:"generation_ms"`
}

// SolveRequest payload for /api/puzzle/solve.
type SolveRequest struct {
	Rows        int     `json:"rows"`
	Cols        int     `json:"cols"`
	PieceIDs    []int   `json:"piece_ids"`
	ColorWeight float64 `json:"color_weight"`
	GeomWeight  float64 `json:"geom_weight"`
}

// SolveResponse response containing animation steps.
type SolveResponse struct {
	Success        bool                   `json:"success"`
	Accuracy       float64                `json:"accuracy"`
	GlobalRotation int                    `json:"global_rotation"`
	SolveTimeMs    int64                  `json:"solve_time_ms"`
	Steps          []solver.PlacementStep `json:"steps"`
	FinalPlacements []FinalPlacementDTO   `json:"final_placements"`
}

// FinalPlacementDTO represents final state of each board slot.
type FinalPlacementDTO struct {
	Row      int `json:"row"`
	Col      int `json:"col"`
	PieceID  int `json:"piece_id"`
	Rotation int `json:"rotation"`
}

// Server state
type Server struct {
	mu            sync.RWMutex
	currentResult *generator.CutResult
	currentImg    image.Image
	staticDir     string
}

func NewServer(staticDir string) *Server {
	return &Server{
		staticDir: staticDir,
	}
}

// CreateStarryNightArtwork creates an artistic procedural canvas resembling Starry Night.
func CreateStarryNightArtwork(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			fx := float64(x) / float64(w)
			fy := float64(y) / float64(h)

			swirl1 := math.Sin(fx*10.0 + fy*6.0 + math.Cos(fy*12.0)*2.0)
			swirl2 := math.Cos(fx*7.0 - fy*9.0 + math.Sin(fx*11.0)*1.5)
			stars := math.Exp(-15.0 * (math.Pow(fx-0.75, 2) + math.Pow(fy-0.25, 2))) * 2.0
			moon := math.Exp(-30.0 * (math.Pow(fx-0.85, 2) + math.Pow(fy-0.18, 2))) * 3.0

			r := math.Min(255, math.Max(0, (0.08+0.5*stars+0.8*moon+0.15*swirl1)*255))
			g := math.Min(255, math.Max(0, (0.15+0.5*stars+0.7*moon+0.25*swirl2+0.1*fy)*255))
			b := math.Min(255, math.Max(0, (0.45+0.1*stars+0.2*moon+0.35*(1.0-fy)+0.2*swirl1)*255))

			img.SetRGBA(x, y, color.RGBA{
				R: uint8(r),
				G: uint8(g),
				B: uint8(b),
				A: 255,
			})
		}
	}
	return img
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(s.staticDir)))
	mux.HandleFunc("/api/puzzle/generate", s.handleGenerate)
	mux.HandleFunc("/api/puzzle/scramble", s.handleScramble)
	mux.HandleFunc("/api/puzzle/solve", s.handleSolve)
	mux.HandleFunc("/api/cv/process-piece", s.handleProcessPiece)
	return mux
}

func (s *Server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req GenerateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Rows < 2 {
		req.Rows = 3
	}
	if req.Cols < 2 {
		req.Cols = 3
	}
	if req.Rows > 40 {
		req.Rows = 40
	}
	if req.Cols > 50 {
		req.Cols = 50
	}
	if req.Seed == 0 {
		req.Seed = time.Now().UnixNano()
	}

	startTime := time.Now()
	var img image.Image
	switch req.Preset {
	case "custom":
		if req.Image != "" {
			dataURL := req.Image
			if idx := bytes.Index([]byte(dataURL), []byte(",")); idx != -1 {
				dataURL = dataURL[idx+1:]
			}
			rawBytes, err := base64.StdEncoding.DecodeString(dataURL)
			if err == nil {
				decImg, _, err := image.Decode(bytes.NewReader(rawBytes))
				if err == nil {
					img = decImg
				}
			}
		}
		if img == nil {
			img = CreateStarryNightArtwork(800, 600)
		}
	case "gradient":
		gImg := image.NewRGBA(image.Rect(0, 0, 800, 600))
		for y := 0; y < 600; y++ {
			for x := 0; x < 800; x++ {
				gImg.SetRGBA(x, y, color.RGBA{
					R: uint8(float64(x) / 800.0 * 255),
					G: uint8(float64(y) / 600.0 * 255),
					B: 180,
					A: 255,
				})
			}
		}
		img = gImg
	default: // "starry_night"
		img = CreateStarryNightArtwork(800, 600)
	}

	cfg := generator.DefaultCutterConfig(req.Rows, req.Cols)
	cfg.Seed = req.Seed
	cfg.ExtractImages = true

	cutRes, err := generator.CutPuzzle(img, cfg)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	s.mu.Lock()
	s.currentResult = cutRes
	s.currentImg = img
	s.mu.Unlock()

	// Convert pieces to DTOs with base64 PNGs
	piecesDTO := make([]PieceDTO, len(cutRes.Pieces))
	for i, p := range cutRes.Pieces {
		var imgBuf bytes.Buffer
		if p.Image != nil {
			_ = png.Encode(&imgBuf, p.Image)
		}
		imgBase64 := base64.StdEncoding.EncodeToString(imgBuf.Bytes())

		var edgesDTO [4]EdgeDTO
		for d := 0; d < 4; d++ {
			edgesDTO[d] = EdgeDTO{
				Direction: p.Edges[d].Dir.String(),
				Type:      p.Edges[d].Type.String(),
				Points:    p.Edges[d].Points,
			}
		}

		piecesDTO[i] = PieceDTO{
			ID:             p.ID,
			OriginalRow:    p.OriginalRow,
			OriginalCol:    p.OriginalCol,
			Classification: string(p.Classification()),
			Rotation:       p.Rotation,
			Bounds: puzzle.Rectangle{
				Min: puzzle.Point2D{X: float64(p.Bounds.Min.X), Y: float64(p.Bounds.Min.Y)},
				Max: puzzle.Point2D{X: float64(p.Bounds.Max.X), Y: float64(p.Bounds.Max.Y)},
			},
			Edges:       edgesDTO,
			ImageBase64: imgBase64,
		}
	}

	resp := GenerateResponse{
		Grid:         cutRes.Grid,
		Pieces:       piecesDTO,
		Width:        cutRes.Width,
		Height:       cutRes.Height,
		GenerationMs: time.Since(startTime).Milliseconds(),
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleScramble(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentResult == nil {
		http.Error(w, "No active puzzle", http.StatusBadRequest)
		return
	}

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	solver.ShuffleAndRotate(s.currentResult.Pieces, rng)

	type ScrambledPieceInfo struct {
		ID       int `json:"id"`
		Rotation int `json:"rotation"`
	}

	res := make([]ScrambledPieceInfo, len(s.currentResult.Pieces))
	for i, p := range s.currentResult.Pieces {
		res[i] = ScrambledPieceInfo{
			ID:       p.ID,
			Rotation: p.Rotation,
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"pieces":  res,
	})
}

func (s *Server) handleSolve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.currentResult == nil {
		http.Error(w, "No active puzzle", http.StatusBadRequest)
		return
	}

	var req SolveRequest
	_ = json.NewDecoder(r.Body).Decode(&req)

	cfg := solver.DefaultSolverConfig()
	if req.ColorWeight > 0 {
		cfg.ColorWeight = req.ColorWeight
	}
	if req.GeomWeight > 0 {
		cfg.GeomWeight = req.GeomWeight
	}
	if s.currentImg != nil {
		cfg.ReferenceMap = registration.NewReferenceMap(s.currentImg, s.currentResult.Grid)
	}

	solveEngine := solver.NewSolver(s.currentResult.Grid, s.currentResult.Pieces, cfg)

	startTime := time.Now()
	solveRes, trace, err := solveEngine.SolveWithTrace()
	elapsed := time.Since(startTime)

	if err != nil || solveRes == nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SolveResponse{
			Success:     false,
			SolveTimeMs: elapsed.Milliseconds(),
		})
		return
	}

	var finals []FinalPlacementDTO
	for r := 0; r < s.currentResult.Grid.Rows; r++ {
		for c := 0; c < s.currentResult.Grid.Cols; c++ {
			p := solveRes.Board.At(r, c)
			if p != nil {
				finals = append(finals, FinalPlacementDTO{
					Row:      r,
					Col:      c,
					PieceID:  p.Piece.ID,
					Rotation: p.Rotation,
				})
			}
		}
	}

	resp := SolveResponse{
		Success:         true,
		Accuracy:        solveRes.Accuracy,
		GlobalRotation:  solveRes.GlobalRotation,
		SolveTimeMs:     elapsed.Milliseconds(),
		Steps:           trace,
		FinalPlacements: finals,
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func suppressJpegImport() {
	_ = jpeg.DefaultQuality
}

// ProcessPieceRequest payload for /api/cv/process-piece
type ProcessPieceRequest struct {
	ImageData string `json:"image_data"` // Base64 data URL
	Threshold uint8  `json:"threshold"`
	InvertBg  bool   `json:"invert_bg"`
}

// ProcessPieceResponse returns extracted contour, corners, edge types, and candidate artwork locations
type ProcessPieceResponse struct {
	Success       bool                              `json:"success"`
	Error         string                            `json:"error,omitempty"`
	CornerPoints  [4]puzzle.Point2D                 `json:"corner_points"`
	Contour       []puzzle.Point2D                  `json:"contour"`
	EdgeTypes     [4]string                         `json:"edge_types"`
	PieceImage    string                            `json:"piece_image"` // Base64 PNG
	TopCandidates []registration.GridLocationCandidate `json:"top_candidates"`
}

func (s *Server) handleProcessPiece(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ProcessPieceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Decode base64 image data URL
	dataURL := req.ImageData
	idx := bytes.Index([]byte(dataURL), []byte(","))
	if idx != -1 {
		dataURL = dataURL[idx+1:]
	}
	rawBytes, err := base64.StdEncoding.DecodeString(dataURL)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ProcessPieceResponse{Success: false, Error: "invalid base64 image"})
		return
	}

	img, _, err := image.Decode(bytes.NewReader(rawBytes))
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ProcessPieceResponse{Success: false, Error: "failed to decode image"})
		return
	}

	if req.Threshold == 0 {
		req.Threshold = 70
	}

	proc, err := cv.SegmentPiece(img, req.Threshold, req.InvertBg)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ProcessPieceResponse{Success: false, Error: err.Error()})
		return
	}

	var imgBuf bytes.Buffer
	if proc.Piece.Image != nil {
		_ = png.Encode(&imgBuf, proc.Piece.Image)
	}
	pieceBase64 := base64.StdEncoding.EncodeToString(imgBuf.Bytes())

	s.mu.RLock()
	var topCandidates []registration.GridLocationCandidate
	if s.currentImg != nil && s.currentResult != nil {
		refMap := registration.NewReferenceMap(s.currentImg, s.currentResult.Grid)
		desc := registration.ExtractDescriptor(proc.Piece.Image, proc.Piece.Mask)
		topCandidates = refMap.LocateCandidates(desc, 3)
	}
	s.mu.RUnlock()

	var edgeNames [4]string
	for i := 0; i < 4; i++ {
		edgeNames[i] = proc.EdgeTypes[i].String()
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(ProcessPieceResponse{
		Success:       true,
		CornerPoints:  proc.CornerPoints,
		Contour:       proc.FullContour,
		EdgeTypes:     edgeNames,
		PieceImage:    pieceBase64,
		TopCandidates: topCandidates,
	})
}
