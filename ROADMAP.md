# Jigsaw Puzzle Solver: Complete Technical Roadmap

This roadmap documents the end-to-end architecture, current completion status, and the sequential engineering milestones ahead for building a production-grade, zero-cloud-cost physical jigsaw puzzle solver using **Rust**, **WebAssembly (WASM)**, and **React/TypeScript**.

---

## 🏛️ System Architecture Overview

```
                      [ PHYSICAL WORLD ]
            Phone / Webcam on Stand pointing at desk
                               |
                               v
               [ PILLAR 1: CALIBRATION & OPTICS ]
       • Industrial 100mm Target (Fiducial Bullseyes)
       • 3x3 Projective Homography (DLT Matrix Inversion)
       • Real-time Orthographic Dewarping & Metric Scale (px/mm)
                               |
                               v
            [ PILLAR 3: GEOMETRIC CONTOUR EXTRACTION ]
       • Adaptive Otsu Binarization + 3x3 Gaussian Blur
       • Moore-Neighbor Radial Boundary Contour Tracing
       • PCA Rotation Invariance & Curvature Extrema Corner Detection
       • 4-Edge Classification (Tab, Hole, Flat) & Dimensions
                               |
                               v
               [ DUAL-MODE PIECE MATCHER ENGINE ]
                 /                           \
                /                             \
     [ Geometric Curve Mating ]      [ Visual Feature Matcher ]
     • Dense Resampled Contours      • ORB / SIFT Keypoint Hashes
     • Turn-Angle Cross-Correlation  • Master Poster Homography
     • Male/Female Tab Tolerance     • Exact Continuous (x,y,θ)
                \                             /
                 \                           /
                               v
           [ PILLAR 4: PERSISTENT ASSEMBLY BOARD GRAPH ]
       • 2D Grid Constraint Propagation (e.g. 42 x 24 Ravensburger)
       • Solved Slot Elimination: O(N) -> O(1) Candidate Search
       • Interactive Virtual Board & AR Placement Guidance
                               |
                               v
              [ EXPORT, PERSISTENCE & COMMUNITY ]
       • Local IndexedDB Session State
       • Step-by-Step Assembly Walkthrough UI
```

---

## 🚦 Roadmap Milestones & Status

| Phase | Milestone | Tech Stack | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Clean Slate & Rust + React WASM Scaffolding | Cargo, Vite, wasm-pack | ✅ **DONE** |
| **Phase 1** | Real-time Camera Feed & Sub-ms Frame Ingestion | WebRTC, Canvas, WASM Memory | ✅ **DONE** |
| **Phase 2** | Pillar 1: Industrial Calibration Mat & 3x3 DLT Homography | Rust (`homography.rs`), Headless Chrome | ✅ **DONE** |
| **Phase 3** | Calibration Mat v5.0: Zero-Bleed L-Crosshairs & Camera Pose HUD | Python (`generate_mat.py`), Canvas HUD | ✅ **DONE** |
| **Phase 4** | Pillar 3: Scale-Invariant Contour & 4-Edge Corner Detection | Rust (`contour.rs`), 90/90 Ground Truth Fixtures | ✅ **DONE** |
| **Phase 5** | Vision Polish: Zero-Lag Sampling & Instant Contour Trigger | Quadrant 85th Percentiles, Deadband Lock, 60ms Tick | ✅ **DONE** |
| **Phase 6** | **Step 1: Master Poster Reference & Coordinate Grid Stage** | React Canvas Pan/Zoom, WASM Texture Index | 🟡 **CURRENT TASK** |
| **Phase 7** | **Step 2: Piece Inventory Management & Interactive Board UI** | IndexedDB / LocalStorage, Tray UI, Manual Snapping | ⏳ Next |
| **Phase 8** | **Step 3: Edge Curve Signatures & Pairwise Mating Engine** | Rust (`matcher.rs`), Arc-length Turn-angles, $L_2$ Error | ⏳ Planned |
| **Phase 9** | **Step 4: Hybrid Visual + Geometric Solver & AR Guidance** | Keypoint Hashes, Graph Search, PWA | ⏳ Planned |

---

## 🔍 Detailed Breakdown of Phases & Current Milestones

### Phase 5: Vision Polish & Zero-Lag Detection (Completed)
* **Accomplishments**:
  - **Quadrant Background Isolation**: Decomposed outer boundary sampling into 4 independent edge strips (Top, Bottom, Left, Right), taking the median clean 85th percentile so shadows from entering/exiting fingers never distort the arena background reference.
  - **Perimeter Margin Intrusion Refinement**: Tuned connected outer intrusion check (>10% sample cutoff) eliminating false obstruction locks from minor corner vignetting or paper warping.
  - **Instant Cadence**: Elevated WASM CV tick rate from 100ms to 60ms (~16.6 FPS) with a 2-frame (120ms) dropout tolerance, making contour overlay appearance instantaneous upon placing a piece.
  - **Deterministic Regressions**: 100% passing across all ground-truth fixtures and wobble-budget tests.

---

### Phase 6: Step 1 — Master Poster Reference & Coordinate Grid Stage (Completed)
* **Rationale**: Requires zero scanned pieces upfront. Establishes the ground-truth visual coordinate space, aspect ratio, and grid division ($C \times R$) against which pieces will be assembled.
* **Accomplishments**:
  - **WASM Poster Engine (`cv-engine/src/poster.rs`)**: RGBA buffer ingestion into Rust memory, multi-scale grayscale image pyramid generation via 2x2 anti-aliased box downsampling, and nominal slot geometry calculation.
  - **Interactive Poster Canvas (`components/PosterCanvas.tsx`)**: Drag-and-drop / file upload, smooth panning & cursor-centered zoom canvas, HUD inspector for slot details, toggleable nominal grid and coordinates overlay.
  - **Puzzle Metadata Pre-sets**: Pre-configured for user's 1008-piece puzzle (700x500 mm, 36x28 grid) with customizable piece counts, physical dimensions, and column/row controls.
  - **Unit Tests**: Full Rust unit test coverage in `poster.rs` verifying luminance conversion, pyramid downsampling stages, 1008-slot grid boundaries, corner/border counts, and error handling.

---

### Phase 7: Step 2 — Piece Inventory Management & Interactive Board UI (Current Task)
* **Rationale**: Creates the critical **human-in-the-loop reactive harness** (Literature Principle 4). As pieces are scanned, they are indexed in an offline persistent tray. Tapping any board slot triggers Mode C targeted hole-filling previews using the poster's visual cues and filters the inventory.
* **Key Tasks**:
  1. **Persistent Piece Tray (IndexedDB / LocalStorage)**:
     - Repository storing scanned piece crops, sub-pixel corners, classification badges (Corner, Border, Interior; Tab/Hole/Flat count), and metric dimensions ($W \times H\text{ mm}$).
     - Ability to tag, inspect, favorite, or pair physical pieces manually.
  2. **Interactive Assembly Board (`components/BoardView.tsx`) with Mode C Hole Targeting**:
     - 2D grid canvas showing empty slots, placed pieces, and candidate slots.
     - Slot targeting: Click any empty slot to load expected artwork crop (`get_slot_preview`), color cue, and filter the tray for compatible complementary tabs/holes.
     - Drag-and-drop piece placement from tray onto the board.
     - Export/import ground-truth assembly pairs as JSON test fixtures for validating Phase 8.

---

### Phase 8: Step 3 — Edge Curve Signatures & Pairwise Mating Engine
* **Rationale**: Validated directly against physical paired pieces curated in Step 2.
* **Key Tasks**:
  1. **Arc-Length Normalized Edge Profiles (`cv-engine/src/matcher.rs`)**:
     - Resample piece edge contours into fixed equidistant points ($N = 100$).
     - Compute invariant intrinsic representations: turn-angle $\theta(s)$ or chord-relative curvature $\kappa(s)$.
  2. **Pairwise Compatibility Scoring**:
     - Fast rejection filter: opposite edge types (Tab $\leftrightarrow$ Hole, Flat $\leftrightarrow$ Flat for outer frame), tab width/height bounding box consistency.
     - Detailed curve match: Euclidean $L_2$ difference between male tab profile and inverted female hole profile across a sliding alignment window.
  3. **Pairwise Test Suite**:
     - Rust unit tests using verified mated piece pairs exported from the Step 2 inventory.

---

### Phase 9: Step 4 — Hybrid Visual + Geometric Solver, AR Guidance & PWA
* **Objective**: Combine edge curves and artwork features into a single global solver, with AR table guidance and offline PWA support.
* **Key Tasks**:
  1. **Visual Keypoint Matching against Reference Poster**:
     - Fast feature matching (FAST / ORB-compatible keypoint hashing) inside the piece's interior texture.
     - RANSAC homography estimation against the reference artwork to determine continuous global $(x, y)$ coordinate and rotation $\theta$.
  2. **Hybrid Constraint Propagation**:
     - Combine **Visual Landmark Score** (from poster) + **Geometric Boundary Score** (from neighbor pieces) to solve slots with $O(1)$ candidate elimination.
  3. **HUD Placement Assistant & AR Table Guidance**:
     - "Next Best Piece to Find" recommendation mode (prioritizing high-contrast borders or unique colors).
     - Augmented visual overlay showing where on the physical table to snap the scanned piece.
  4. **Offline PWA & Session Persistence**:
     - Service worker caching for 100% offline WASM execution.
     - IndexedDB persistence to resume 1,000-piece puzzle progress across days/weeks.
