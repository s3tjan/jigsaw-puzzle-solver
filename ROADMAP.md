# Jigsaw Puzzle Solver: Technical Architecture & Roadmap

This document defines the mathematical strategy, physical constraints, computer vision pipeline, milestone tracker, and phase specifications for solving a 1,008-piece physical jigsaw puzzle using **Rust**, **WebAssembly (WASM)**, and **React/TypeScript**.

---

## 1. Physical Reality & Core Operating Constraints

Physical jigsaw puzzle assembly via an overhead camera and WebAssembly operates under strict physical and optical realities:

1. **Zero Physical Labeling**: Pieces are pulled at random from a mixed cardboard box. The user never labels, numbers, or pre-sorts pieces. The system must accept any arbitrary piece and direct the user where it belongs.
2. **Die Repeatability (Identical Twins)**: Commercial manufacturers stamp 1,000-piece puzzles using a 250-piece die repeated 4 times or flipped 180°. Pure contour geometry cannot distinguish between identical die twins on opposite sides of the puzzle.
3. **Cardboard Kerf & Shadow Noise**: Die-cut edges produce 1–3 pixel variations under ambient lighting and knife wear. Mating algorithms must evaluate contours within mathematical tolerances rather than expecting bitwise "identical" lines.
4. **The Single-Piece Poster Trap**: An isolated interior piece with low spatial entropy (e.g., solid sky, dark foliage) produces dozens of false-positive correlation peaks across the reference poster. Single-piece poster matching must be treated as a **spatial probability distribution**, not an absolute coordinate.
5. **Universal Solver Generalization (1,008-Piece Scope)**: The ultimate goal is solving the complete 1,008-piece puzzle, not just the perimeter. The 124 border pieces serve as the initial validation set and rigid frame anchor, but the underlying 7-step mating pipeline (topology $\to$ metric tolerances $\to$ seam ink MGC $\to$ sub-pixel contour analysis $\to$ best-buddies $\to$ cluster formation $\to$ poster alignment) is mathematically universal across all 1,008 pieces. Algorithms and data structures must never be siloed as border-only one-offs.

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
        • Sub-pixel Corner Detection & 4-Edge Classification
        • Contour Masking (Transparent Background) & Normalized Profiles
        • Metric Edge Baseline & Tab/Hole Millimeter Sizing
                                |
                                v
             [ STAGE 2: UNIVERSAL 7-STEP MATING ENGINE ]
        1. Edge Topology (Tab ↔ Hole polarity)
        2. Metric Dimensions (±0.3mm baseline & tab tolerances)
        3. Seam Ink Continuity (Modified Gradient Compatibility - MGC)
        4. Sub-pixel Interlocking Contour Analysis (within tolerance)
        5. Mutual Best-Buddies Consensus Clustering
        6. Constrained Optimization (Border Loop or Island Clusters)
        7. Frame & Cluster to Poster Rigid Alignment
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
        • Isolated Board Pan/Zoom (>3px threshold, no accidental placements)
        • Upright Cell Art Rendering without Mat Artifacts or CV Lines
        • Zero-Tagging Human Tabletop Placement Guidance
```

---

## 3. Two-Stage Solving Strategy

The solver divides physical assembly into two operational workflows:

```
┌────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: MULTIMODAL GLOBAL BORDER OPTIMIZATION (Offline, Closed Set)   │
│ • All 124 border pieces scanned upfront.                               │
│ • Universal 7-step mating pipeline (Topology → Metric → MGC → Contour) │
│ • Mutual Best-Buddies micro-clustering.                                │
│ • Global loop closure enforcing exact side counts (34 × 26 × 34 × 26). │
│ • Frame-to-Poster rigid alignment locks all 124 pieces.                │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: INWARD BOUNDARY STREAMING & HEATMAPS (Online, Random Draw)    │
│ • User draws any random piece from the box and stages it.              │
│ • Priority 1 (Boundary Extension): Check against 120 exposed seams.    │
│ • Priority 2 (Pocket Filling): Check 2-edge and 3-edge pockets.        │
│ • Priority 3 (Island Heatmap): If unanchored, compute 28×36            │
│   Probability Density Heatmap P(R, C | I) across the grid.             │
│ • Cluster Collapse: Snapping 2–3 island pieces multiplies entropy,     │
│   collapsing diffuse heatmaps into pinpoint coordinates.               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Milestone Status

| Phase | Milestone | Tech Stack | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Rust + React WASM Scaffolding | Cargo, Vite, wasm-pack | **DONE** |
| **Phase 1** | Real-time Camera Feed & Frame Ingestion | WebRTC, Canvas, WASM Memory | **DONE** |
| **Phase 2** | 100mm Calibration Mat & 3x3 Homography | Rust (`homography.rs`), Canvas | **DONE** |
| **Phase 3** | Sub-pixel Contour Extraction & 4-Edge Classification | Rust (`contour.rs`), 90 Fixtures | **DONE** |
| **Phase 4** | Zero-Lag Sampling & Audio Detection Chime | Web Audio API, Stability Consensus | **DONE** |
| **Phase 5** | Reference Poster Ingestion & Metric Grid Setup | WASM Pyramids, CLAHE, CIELAB | **DONE** |
| **Phase 6** | UI Ergonomics, Lens K1 & Canvas Interaction Polish | React Canvas, Full-Screen Modal | **DONE** |
| **Phase 7** | Multimodal Perimeter Frame Solver | Rust (`matcher.rs`), MGC, Best-Buddies | **CURRENT** |
| **Phase 8** | Inward Boundary Propagation & Pocket Filling | Rust WASM, Adjacency Graph | ⏳ Planned |
| **Phase 9** | Spatial Probability Density Heatmaps & Island Clustering | WASM Heatmap Grid, Canvas Shading | ⏳ Planned |

---

## 5. Phase Specifications

### Phase 6: UI Ergonomics, Lens K1 & Canvas Interaction Polish (Complete)
* **Lens K1 Consolidation**: Moved the Lens K1 slider, sensitivity, and calibration mat download into the full-screen camera modal; eliminated the main screen footer controls.
* **Canvas Pan vs. Click Isolation**: Enforced a drag-distance threshold ($>3\text{ px}$) on the board canvas to prevent accidental piece placement during viewport panning.
* **Clean Piece Artwork Rendering**: Replaced raw mat thumbnails with contour-masked piece artwork (transparent background outside the contour, upright cardinal orientation, aspect-ratio preserved, zero CV markers or green contour lines).
* **Interface Decluttering**: Removed manual mating pair verification controls, dashed seam lines, candidate badge clutter, and redundant action buttons.

### Phase 7: Multimodal Perimeter Frame Solver (Current)

> [!IMPORTANT]
> **Universal Engine Design (1,008-Piece Scalability)**: While Phase 7 validates and anchors the initial closed-loop on the 124 border pieces, all underlying algorithms (topology, metric tolerances, seam ink MGC, and sub-pixel contour matching) are built from day one as the universal mating engine for the entire 1,008-piece puzzle. The border loop is simply the perimeter constraint on a solver that directly powers Phase 8 (boundary propagation/pocket filling) and Phase 9 (island clustering).

The solver filters candidate pairs through the cascading 7-step constraint hierarchy:

1. **Step 1: Edge Topology Filtering**: Enforce discrete edge polarity (Tab requires a Hole; Flat outer edges never search for mates). Cheap, fast $O(1)$ binary check (either has it or doesn't). Border pieces have exactly 1 flat edge; corners have 2 perpendicular flat edges.
2. **Step 2: Metric Dimension Tolerances**: Reject candidate border seams whose baseline length, tab width, or tab depth differ by more than $\pm 0.3\text{ mm}$ (fast $O(1)$ dimensional check using the $96\text{ px} = 25.0\text{ mm}$ scale).
3. **Step 3: Seam Ink Continuity (MGC)**: Measure color gradient continuity across candidate cut seams:
   $$\text{Cost}_{\text{MGC}}(u, v) = \sum_{k} \| \nabla I_u(k) - \nabla I_v(k) \|^2$$
   Eliminates identical die-cutter twins stamped from different quadrants.
4. **Step 4: Sub-pixel Interlocking Contour Analysis**: Compare complementary tongue-and-groove contour curves within tolerance (normalized profile, neck width, ear roundness, and entry angle) as the decisive physical check before clustering. Discard false pairings where ink and baseline match but physical contours collide or fail mechanical fit.
5. **Step 5: Mutual Best-Buddies Graph**: Lock pairs into rigid micro-clusters if and only if both pieces rank each other as #1 across combined metric, ink, and contour criteria:
   $$\text{Rank}(A \to B) = 1 \quad \text{AND} \quad \text{Rank}(B \to A) = 1$$
6. **Step 6: Micro-Clusters & Global $34 \times 26$ Loop Optimization**: Assemble micro-clusters into a closed ring satisfying exact side counts (Top: 34, Right: 26, Bottom: 34, Left: 26 non-corner pieces) with minimal seam residual.
7. **Step 7: Frame-to-Poster Rigid Alignment**: Anchor the assembled 124-piece rectangular frame to the master reference poster with zero coordinate ambiguity.

### Phase 8: Inward Boundary Propagation & Pocket Filling (Planned)
* **Active Boundary Indexing**: Expose the 120 inward-facing seams of the locked border frame.
* **1-Edge Boundary Snapping**: Test randomly drawn interior pieces against exposed boundary seams: evaluate (1) Edge polarity (Tab ↔ Hole) $\to$ (2) Metric tolerances ($\pm 0.3\text{ mm}$) $\to$ (3) Seam ink continuity (MGC) $\to$ (4) Sub-pixel interlocking contour curve fit before placing on the board.
* **Multi-Edge Pocket Locking**: Automatically detect 2-edge and 3-edge pockets (e.g. `[1, 1]`) and enforce simultaneous multi-seam constraints (metric, ink, and contour curve interlocking) for 100% deterministic placement.

### Phase 9: Spatial Probability Density Heatmaps & Island Clustering (Planned)
* **Spatial Probability Heatmap**: For pieces not connecting to the active boundary, compute the $28 \times 36$ probability distribution $P(R, C \mid I)$ across the grid and render a soft regional heat glow:
  $$P(R, C \mid I) \propto \exp\left(\frac{S(R, C) - \max(S)}{\tau}\right)$$
* **High-Entropy Landmark Pinpointing**: Pieces with distinct high-contrast artwork (text, faces) anchor directly as island markers.
* **Cluster Entropy Multiplication**: Snapping 2–3 pieces together in an island zone multiplies spatial entropy, collapsing diffuse regional heatmaps into exact, unique grid coordinates.

---

## 6. Visual Standards for the Assembly Board

To ensure the board view is a clean, practical assembly tool:
1. **Contour-Masked Piece Artwork**: Pixels outside the piece contour are masked transparent. Upright cardinal alignment, aspect-ratio preserved, zero CV lines or green corner dots.
2. **Pan / Zoom Isolation**: Mouse movement during drag/pan $>3\text{ px}$ prevents accidental piece placement.
3. **Clean HUD Overlays**: Active placement indicators render as a single distinct highlight; regional candidate zones render as soft translucent heat glows.
4. **Streamlined Calibration**: Lens K1 distortion and calibration controls live exclusively in the full-screen modal; the main workbench remains completely free of optical debug sliders.
