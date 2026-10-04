# Jigsaw Puzzle Solver: Technical Architecture & Roadmap

This document defines the mathematical strategy, physical constraints, computer vision pipeline, milestone tracker, and phase specifications for solving a 1,008-piece physical jigsaw puzzle using **Rust**, **WebAssembly (WASM)**, and **React/TypeScript**.

---

## 1. Physical Reality & Core Operating Constraints

Physical jigsaw puzzle assembly via an overhead camera and WebAssembly operates under strict physical and optical realities:

1. **Zero Physical Labeling**: Pieces are pulled at random from a mixed cardboard box. The user never labels, numbers, or pre-sorts pieces. The system accepts any arbitrary piece and directs the user where it belongs.
2. **Die Repeatability (Identical Twins)**: Commercial manufacturers stamp 1,000-piece puzzles using a repeating die pattern (e.g. 250 pieces repeated 4 times). Pure contour geometry cannot distinguish between identical die twins on opposite sides of the puzzle.
3. **Cardboard Kerf & Shadow Noise**: Die-cut edges produce 1–3 pixel variations under ambient lighting and knife wear. Mating algorithms must evaluate contours within mathematical tolerances rather than expecting bitwise identical lines.
4. **The Single-Piece Poster Trap**: An isolated interior piece with low spatial entropy (e.g., solid sky, dark foliage) produces multiple false-positive correlation peaks across the reference poster. Single-piece poster matching must be treated as a **spatial probability distribution**, not an absolute coordinate.
5. **Human-Machine Synergy**: Rather than relying on an automated, brittle 1D contour-chaining solver that suffers from combinatorial errors and cumulative drift, the system leverages physical human anchoring for the perimeter frame and uses computer vision to deliver rapid spatial heatmaps.

---

## 2. End-to-End System Architecture

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
             [ STAGE 1: CONTOUR & CLEAN ARTWORK EXTRACTION ]
        • Adaptive Otsu Binarization + 3-pass Binomial Gaussian Smoothing
        • Sub-pixel Corner Detection & 4-Edge Classification (Tab / Hole / Flat)
        • Contour Masking (Transparent Background) & Normalized Profiles
        • Metric Edge Baseline & Tab/Hole Millimeter Sizing
                                |
                                v
               [ STAGE 2: PHYSICAL BORDER ANCHORING ]
        • User assembles the physical border on table (124 pieces, 34×26 grid)
        • Anchors the global physical coordinate frame [R ∈ 0..25, C ∈ 0..33]
        • Bypasses brittle automated 1D seam loop chaining
                                |
                                v
         [ STAGE 3: RANDOM DRAW & SPATIAL PROBABILITY HEATMAPS ]
        • User pulls random piece from box and stages on camera
        • Edge Topology Pruning: Flat edges (border/corner) vs. Interior tabs/holes
        • Poster Visual Correlation: 4×4 spatial descriptors + CIELAB + Sobel gradients
        • 28×36 Candidate Probability Density Heatmap P(R, C | Piece)
        • Neighboring boundary tab/hole polarity validation on active frontier
                                |
                                v
                [ STAGE 4: CLEAN ASSEMBLY WORKBENCH ]
        • Isolated Board Pan/Zoom (>3px threshold, no accidental placements)
        • Upright Cell Art Rendering without Mat Artifacts or CV Lines
        • Interactive Heatmap Overlay: Highlighting probable candidate slots
        • Click-to-Confirm slot placement updating remaining board occupancy
```

---

## 3. Practical Assembly Strategy

The solver operates on a streamlined 3-step workflow:

```
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 1: UPFRONT PIECE SCANNING (Fast Ingestion)                        │
│ • Rapidly stage pieces on the mat (automated capture with audio chime).│
│ • Extract sub-pixel contour, 4-edge classification, and clean artwork. │
│ • Store pieces in local inventory database.                            │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 2: MANUAL BORDER ASSEMBLY (Physical Frame Anchoring)              │
│ • User manually builds the 124-piece border loop on the physical table.│
│ • Eliminates combinatorial die-cut seam errors and cascading failure.  │
│ • Establishes definitive 34 × 26 physical grid frame.                  │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 3: CANDIDATE HEATMAP & RANDOM DRAW GUIDANCE                       │
│ • User picks any random piece from the box and stages it under camera. │
│ • Topology Filter: Excludes occupied slots and incompatible polarities.│
│ • Multimodal Heatmap Engine: Evaluates 4×4 spatial descriptors, CIELAB │
│   color, and edge gradients against resident poster in WASM (<3ms).    │
│ • Renders 28×36 Candidate Probability Density Heatmap on board canvas. │
│ • User places piece in top-matching physical slot and confirms in UI.  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Milestone Status

| Phase | Milestone | Tech Stack | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Rust + WASM Scaffolding | Cargo, wasm-pack | **DONE** |
| **Phase 1** | Real-time Camera Feed & Frame Ingestion | WebRTC, Canvas, WASM Memory | **DONE** |
| **Phase 2** | 100mm Calibration Mat & 3x3 Homography | Rust (`homography.rs`), Canvas | **DONE** |
| **Phase 3** | Sub-pixel Contour Extraction & 4-Edge Classification | Rust (`contour.rs`), 90 Fixtures | **DONE** |
| **Phase 4** | Zero-Lag Sampling & Audio Detection Chime | Web Audio API, Stability Consensus | **DONE** |
| **Phase 5** | Reference Poster Ingestion & Metric Grid Setup | WASM Pyramids, CLAHE, CIELAB | **DONE** |
| **Phase 6** | Frontend Modernization: Angular Architecture Reset | Angular (Standalone, Signals, Services) | **CURRENT** |
| **Phase 7** | Spatial Probability Density Heatmap & Candidate Engine | Rust WASM (`poster.rs`), Canvas Heatmap | ⏳ Planned |
| **Phase 8** | Board State Frontier & Occupancy Tracking | Angular Signals / WASM Board Frontier | ⏳ Planned |
| **Phase 9** | Multi-Piece Cluster Snapping & Heatmap Collapse | Cluster Descriptor Correlation | ⏳ Planned |

---

## 5. Phase Specifications

### Phase 6: UI Ergonomics, Lens K1 & Canvas Interaction Polish (Complete)
* **Lens K1 Consolidation**: Moved the Lens K1 slider, sensitivity, and calibration mat download into the full-screen camera modal; eliminated the main screen footer controls.
* **Canvas Pan vs. Click Isolation**: Enforced a drag-distance threshold ($>3\text{ px}$) on the board canvas to prevent accidental piece placement during viewport panning.
* **Clean Piece Artwork Rendering**: Replaced raw mat thumbnails with contour-masked piece artwork (transparent background outside the contour, upright cardinal orientation, aspect-ratio preserved, zero CV markers or green contour lines).
* **Interface Decluttering**: Removed manual mating pair verification controls, dashed seam lines, candidate badge clutter, and redundant action buttons.

### Phase 7: Spatial Probability Density Heatmap & Candidate Engine (Current)

> [!NOTE]
> **Pivot from Automated Seam Chaining**: Pairwise 1-to-1 boundary seam interlocking alone achieves only 30–40% reliability across 124 border pieces due to die repetition, cardboard kerf/bevel wear, and greedy error accumulation. Rather than stalling on an automated 1D perimeter loop solver, the system anchors the 34×26 grid via manual physical border assembly and guides piece placement via candidate heatmaps.

The heatmap engine generates candidate slot probabilities $P(R, C \mid \text{piece})$ in <3ms using Rust WASM:

1. **Topology & Occupancy Masking**:
   - Filter out already-occupied grid slots.
   - Restrict pieces with flat edges to remaining perimeter slots.
   - Enforce discrete edge polarity (Tab ↔ Hole) against adjacent placed neighbors on the active board frontier.
2. **Visual Correlation with Reference Poster**:
   - Evaluate rectified piece patch against resident poster slots using 4×4 spatial cell descriptors (`locate_piece_spatial` in `poster.rs`).
   - Compare CIELAB color profiles and Sobel gradient orientation histograms across all 4 cardinal rotations.
3. **Heatmap Generation & UI Rendering**:
   - Compute normalized candidate score matrix $S(R, C) \in [0.0, 1.0]$.
   - Render soft translucent heat glow overlay on the board canvas with top 3–5 candidate highlights.
   - Provide rotation angle recommendation for the highest-probability slot.

### Phase 8: Board State Frontier & Occupancy Tracking (Planned)
* **Interactive Slot Confirmation**: Allow user to click/tap a board slot to confirm piece placement, updating the remaining vacancy pool.
* **Frontier Edge Indexing**: Maintain an index of exposed tabs and holes along the assembly frontier to narrow candidate slots automatically.
* **Conflict Resolution**: Permit reassignment or removal of placed pieces if physical fitting reveals an error.

### Phase 9: Multi-Piece Cluster Snapping & Heatmap Collapse (Planned)
* **Cluster Entropy Multiplication**: When 2–3 pieces in an island zone snap together on the table, stage the connected cluster as a single composite piece.
* **Heatmap Collapse**: Evaluate combined cluster descriptors against the poster, collapsing diffuse regional glows into a single pinpoint slot.

---

## 6. Visual Standards for the Assembly Board

To ensure the board view is a clean, practical assembly tool:
1. **Contour-Masked Piece Artwork**: Pixels outside the piece contour are masked transparent. Upright cardinal alignment, aspect-ratio preserved, zero CV lines or green corner dots.
2. **Pan / Zoom Isolation**: Mouse movement during drag/pan $>3\text{ px}$ prevents accidental piece placement.
3. **Clean HUD Heatmap Overlays**: Render candidate probability density as soft glowing highlights with top-choice emphasis; no raw debug line clutter.
4. **Streamlined Calibration**: Lens K1 distortion and calibration controls live exclusively in the full-screen modal; the main workbench remains completely free of optical debug sliders.
