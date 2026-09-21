package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"path/filepath"

	"jig/pkg/server"
)

func main() {
	port := flag.Int("port", 8080, "HTTP server port")
	staticDir := flag.String("static", "web", "Path to static web directory")
	flag.Parse()

	absStatic, err := filepath.Abs(*staticDir)
	if err != nil {
		absStatic = *staticDir
	}

	srv := server.NewServer(absStatic)
	addr := fmt.Sprintf(":%d", *port)

	fmt.Printf("====================================================\n")
	fmt.Printf("🧩 Jigsaw Puzzle Solver Web Workbench\n")
	fmt.Printf("Listening at: http://localhost:%d\n", *port)
	fmt.Printf("Serving static assets from: %s\n", absStatic)
	fmt.Printf("====================================================\n")

	if err := http.ListenAndServe(addr, srv.Routes()); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
