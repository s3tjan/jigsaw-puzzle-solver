# Jigsaw Puzzle Solver: Technical Roadmap

This roadmap documents the system architecture, milestone status, and implementation phases for the physical jigsaw puzzle solver using **Rust**, **WebAssembly (WASM)**, and **React/TypeScript**.

For the foundational theory, physical constraints, and multimodal mathematics, see **[ASSEMBLY_STRATEGY.md](file:///home/stbn/projects/jigsaw-puzzle-solver/docs/ASSEMBLY_STRATEGY.md)**.

---

## System Architecture

```
                       [ PHYSICAL WORLD ]
             Overhead Camera pointing at staging mat
                                |
                                v
                [ STAGE 0: CALIBRATION & OPTICS ]
        • 100mm Target (Fiducial Corners C1–C4)
        • Full-Screen Calibration Modal with Lens K1 Tuning
        • Real-time Orthographic Dewarping & Metric Scale (96px = 25mm)
                                |
                                v
             [ STAGE 1: GEOMETRIC CONTOUR & ARTWORK EXTRACTION ]
        • Adaptive Otsu Binarization + Gaussian Smoothing
        • Sub-pixel Corner Detection & 4-Edge Classification
        • Contour Masking (Transparent Background) & Normalized Profiles
        • Metric Edge Baseline & Tab/Hole Millimeter Sizing
                                |
                                v
          [ STAGE 2: MULTIMODAL PERIMETER SOLVER (124 PIECES) ]
        • Metric Dimension Pruning (±0.3mm baseline, tab width/depth)
        • Discrete Tab/Hole Polarity Validation
        • Seam Ink Continuity (Modified Gradient Compatibility - MGC)
        • Mutual Best-Buddies Micro-Clustering
        • Global Constrained Loop Optimization (34 × 26 × 34 × 26 pieces)
        • Frame-to-Poster Rigid Alignment
                                |
                                v
          [ STAGE 3: INWARD BOUNDARY STREAMING & HEATMAPS ]
        • 1-Edge Boundary Extension across Exposed Border Seams
        • 2-Edge & 3-Edge Pocket Filling (Deterministic Dual-Seam Locks)
        • 28×36 Spatial Probability Density Heatmaps P(R, C | I)
        • Island Cluster Assembly (Entropy Multiplication & Heatmap Collapse)
                                |
                                v
                [ STAGE 4: CLEAN ASSEMBLY WORKBENCH ]
        • Isolated Board Pan/Zoom (No Accidental Drag-Placements)
        • Upright Cell Art Rendering without Mat Artifacts
        • Zero-Tagging Human Tabletop Guidance
```

---

## Milestone Status

| Phase | Milestone | Tech Stack | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Rust + React WASM Scaffolding | Cargo, Vite, wasm-pack | **DONE** |
| **Phase 1** | Real-time Camera Feed & Frame Ingestion | WebRTC, Canvas, WASM Memory | **DONE** |
| **Phase 2** | 100mm Calibration Mat & 3x3 Homography | Rust (`homography.rs`), Canvas | **DONE** |
| **Phase 3** | Sub-pixel Contour Extraction & 4-Edge Classification | Rust (`contour.rs`), 90 Fixtures | **DONE** |
| **Phase 4** | Zero-Lag Sampling & Audio Detection Chime | Web Audio API, Stability Consensus | **DONE** |
| **Phase 5** | Reference Poster Ingestion & Metric Grid Setup | WASM Pyramids, CLAHE, CIELAB | **DONE** |
| **Phase 6** | UI Ergonomics, Lens K1 & Canvas Interaction Polish | React Canvas, Full-Screen Modal | **CURRENT** |
| **Phase 7** | Multimodal Perimeter Frame Solver | Rust (`matcher.rs`), MGC, Best-Buddies | **CURRENT** |
| **Phase 8** | Inward Boundary Propagation & Pocket Filling | Rust WASM, Adjacency Graph | ⏳ Planned |
| **Phase 9** | Spatial Probability Density Heatmaps & Island Clustering | WASM Heatmap Grid, Canvas Shading | ⏳ Planned |

---

## Phase Details

### Phase 6: UI Ergonomics, Lens K1 & Canvas Interaction Polish (Current)
* **Lens K1 Consolidation**: Move the Lens K1 slider into the full-screen camera calibration modal alongside fiducial corner adjustments; eliminate the main screen footer controls.
* **Canvas Pan vs. Click Isolation**: Enforce a drag-distance threshold ($>3\text{ px}$) on the board canvas to prevent accidental piece placement during viewport panning.
* **Clean Piece Artwork Rendering**: Replace raw mat thumbnails with contour-masked piece artwork (transparent background, upright cardinal orientation, zero CV markers or green contour lines).
* **Interface Decluttering**: Remove obsolete manual mating pair verification controls, candidate badge clutter, and redundant action buttons.

### Phase 7: Multimodal Perimeter Frame Solver (Current)
* **Metric Dimension Tolerances**: Reject candidate border seams whose baseline length, tab width, or tab depth differ by more than $\pm 0.3\text{ mm}$.
* **Seam Ink Continuity (MGC)**: Measure color gradient continuity across candidate cut seams to eliminate identical die-cutter twins from different quadrants.
* **Mutual Best-Buddies Graph**: Lock pairs into rigid micro-clusters if and only if both pieces rank each other as #1.
* **Global $34 \times 26$ Loop Optimization**: Assemble micro-clusters into a closed ring satisfying exact side counts (Top: 34, Right: 26, Bottom: 34, Left: 26 non-corner pieces).
* **Frame-to-Poster Rigid Alignment**: Anchor the assembled 124-piece rectangular frame to the master reference poster with zero coordinate ambiguity.

### Phase 8: Inward Boundary Propagation & Pocket Filling (Planned)
* **Active Boundary Indexing**: Expose the 120 inward-facing seams of the locked border frame.
* **1-Edge Boundary Snapping**: Test randomly drawn interior pieces against exposed boundary seams using metric tolerances + MGC seam ink continuity.
* **Multi-Edge Pocket Locking**: Automatically detect 2-edge and 3-edge pockets (e.g. `[1, 1]`) and enforce simultaneous multi-seam constraints for 100% deterministic placement.

### Phase 9: Spatial Probability Density Heatmaps & Island Clustering (Planned)
* **Spatial Probability Heatmap**: For pieces not connecting to the active boundary, compute the $28 \times 36$ probability distribution $P(R, C \mid I)$ across the grid and render a soft regional heat glow.
* **High-Entropy Landmark Pinpointing**: Pieces with distinct high-contrast artwork anchor directly as island markers.
* **Cluster Entropy Multiplication**: Snapping 2–3 pieces together in an island zone multiplies spatial entropy, collapsing diffuse regional heatmaps into exact, unique grid coordinates.
