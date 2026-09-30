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
| :--- | :--- | :--- | :---: |
| **Phase 0** | Clean Slate & Rust + React WASM Scaffolding | Cargo, Vite, wasm-pack | ✅ **DONE** |
| **Phase 1** | Real-time Camera Feed & Sub-ms Frame Ingestion | WebRTC, Canvas, WASM Memory | ✅ **DONE** |
| **Phase 2** | Pillar 1: Industrial Calibration Mat & 3x3 DLT Homography | Rust (`homography.rs`), Headless Chrome | ✅ **DONE** |
| **Phase 3** | Calibration Mat v5.0: Zero-Bleed L-Crosshairs & Camera Pose HUD | Python (`generate_mat.py`), Canvas HUD | ✅ **DONE** |
| **Phase 4** | Pillar 3: Scale-Invariant Contour & 4-Edge Corner Detection | Rust (`contour.rs`), 82/82 Ground Truth Fixtures | ✅ **DONE** |
| **Phase 5** | Vision Polish: Macro Wobble Deadband & Auto-Capture Pipeline | Moving Window Blur, Deadband Lock, Web Audio | ✅ **DONE** |
| **Phase 6** | **Pillar 4: Pairwise Curve Mating & Border Loop Solver** | Rust (`matcher.rs`, `board.rs`), Turn Angles | 🟡 **IN PROGRESS** |
| **Phase 7** | **Visual Matching against Master Artwork Poster** | Rust / WASM Keypoints, FLANN / KD-Tree | ⏳ Planned |
| **Phase 8** | **Interactive AR Placement Guidance & Session Storage** | IndexedDB, Canvas 2D/WebGL Overlay | ⏳ Planned |
| **Phase 9** | **PWA Packaging & Mobile Optimization** | Service Workers, Web App Manifest | ⏳ Planned |

---

## 🔍 Detailed Breakdown of Phases & Current Milestones

### Phase 3: Calibration Mat v5.0 & Camera Alignment Guidance (Completed)
* **Accomplishments**:
  - **Zero-Bleed Outward L-Crosshairs**: Corner targets engineered with orthogonal arms extending strictly outward from the $65 \times 65\text{ mm}$ scan area directly to $(vx, vy)$ with red nodal cores ($0.35\text{ mm}$), ensuring zero ink intrusion into the piece detection arena.
  - **Tight FOV Visual Marks**: Added $77 \times 77\text{ mm}$ framing brackets and parallel horizon rails designed for close-up macro webcam stands.
  - **Single-Source Assets in `web-app/public/`**: `calibration_mat.pdf` (1:1 true scale print), `calibration_mat.svg`, and `calibration_mat.png` directly downloadable and served by Vite.
  - **Real-Time Camera Pose & Optical Reticle**: High-contrast magenta/cyan center reticle and real-time live Pitch, Yaw, and Roll readouts for leveling the camera against the desk.

---

### Phase 4 & 5: Scale-Invariant Contour Extraction & Macro Stabilization (Completed)
* **Accomplishments**:
  - **Scale-Invariant Quad Scoring**: Segment-voting and radius-normalized corner metrics ($r_{\text{est}}$ normalization) preventing false flat-edge classification across varying camera distances (macro close-up vs wide field).
  - **100% Ground Truth Regression Suite**: All 82 scanned physical piece fixtures passing deterministic corner classification tests (`cv-engine/scans/ground_truth/`).
  - **Deadband Wobble Lock-On**: Sub-pixel sensor noise filter freezing corner drift ($<2.2\text{ px}$) when the piece is physically stationary ($<1.8\text{ px}$ centroid movement).

---

### Phase 6: Pairwise Curve Mating & Border Loop Solver (Current Focus)
* **Objective**: Connect complementary tabs and blanks geometrically, assembling the closed outer perimeter frame.
* **Key Tasks**:
  1. **Normalized Curve Signatures (`cv-engine/src/matcher.rs`)**:
     - Resample piece edges into arc-length normalized equidistant points (e.g. 100 points per edge).
     - Represent edge profile using intrinsic turn-angle $\theta(s)$ or chord-curvature signatures invariant to rigid Euclidean transformation.
  2. **Pairwise Compatibility Scoring**:
     - Complementary matching: evaluate $L_2$ error between male tab curve and inverted female blank curve.
     - Prune impossible pairs (tab-tab, blank-blank, or bounding-box width/height mismatch).
  3. **Border Loop Solver (`cv-engine/src/board.rs`)**:
     - Connect the 4 corner pieces (2 adjacent flat edges) and the ~36 border pieces (1 flat edge).
     - Circular constraint satisfaction: the closed loop must form a rigid rectangle matching expected grid dimensions ($W \times H$).
  4. **Virtual Assembly Preview (`web-app/src/components/BoardView.tsx`)**:
     - Interactive visual board showing solved clusters, candidate edge snaps, and confidence heatmaps.

---

### Phase 7: Master Artwork Reference & Visual Feature Matching
* **Objective**: Solve pieces with intricate artwork (faces, buildings, textures) via continuous landmark coordinates.
* **Key Tasks**:
  1. **Master Poster Upload**:
     - Allow user to upload the reference image of the puzzle box.
     - Rust precomputes a multi-scale spatial index of the artwork.
  2. **Feature Extractor in WASM**:
     - Fast corner/feature detector (FAST / ORB-compatible keypoint hashing) inside the piece's interior texture.
     - RANSAC homography estimation against the reference artwork to determine the exact global $(x, y)$ coordinate and continuous rotation $\theta$.
  3. **Hybrid Voting System**:
     - Combine **Visual Landmark Score** (from poster) + **Geometric Boundary Score** (from neighbor pieces).

---

### Phase 8: Interactive AR Guidance & Session Persistence
* **Objective**: Provide frictionless user guidance and ensure puzzle state survives browser restarts.
* **Key Tasks**:
  1. **IndexedDB Session Store**:
     - Save scanned piece contours, edge signatures, and board placement state locally.
     - Enable resuming a 1,000-piece puzzle across multiple days/weeks.
  2. **HUD Placement Assistant**:
     - "Next Best Piece to Find" recommendation mode (e.g., searches for easy high-contrast corners or distinct colors first).
     - Augmented visual overlay showing where on the physical table to snap the scanned piece.

---

### Phase 9: Progressive Web App (PWA) & Open Source Release
* **Objective**: Package the application for seamless zero-install mobile and desktop use.
* **Key Tasks**:
  1. **Offline PWA**:
     - Service worker caching so the entire WASM CV engine works offline without an internet connection.
  2. **Mobile Layout Polish**:
     - Responsive mobile viewport optimizations for clamping a smartphone directly over a desk stand.
  3. **Documentation & Printable Assets**:
     - Clean GitHub repository README with embedded printable PDF target links, setup diagrams, and architecture documentation.
