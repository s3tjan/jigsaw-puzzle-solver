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
| **Phase 3** | Calibration Polish: Bullseye Centroid Snapping & LocalStorage | Rust (`aruco.rs`), HTML5 Pointer Events | ✅ **DONE** |
| **Phase 4** | Pillar 3: Boundary Segmentation & 4-Edge Classification | Rust (`contour.rs`), PCA, Otsu | ✅ **DONE** |
| **Phase 5** | Vision Polish: Rotation Invariance & Hands-Free Auto-Capture | Web Audio API, Moving Window Blur | ✅ **DONE** |
| **Phase 6** | **Pillar 4: Persistent Assembly Board Graph** | Rust (`board.rs`), React Canvas Grid | 🟡 **UP NEXT** |
| **Phase 7** | **Visual Matching against Master Artwork Poster** | Rust / WASM Keypoints, FLANN / KD-Tree | ⏳ Planned |
| **Phase 8** | **Interactive AR Placement Guidance & Session Storage** | IndexedDB, Canvas 2D/WebGL Overlay | ⏳ Planned |
| **Phase 9** | **PWA Packaging & Mobile Optimization** | Service Workers, Web App Manifest | ⏳ Planned |

---

## 🔍 Detailed Breakdown of Upcoming Phases

### Phase 6: Pillar 4 — Persistent Assembly Board Graph (Current Target)
* **Objective**: Transform isolated piece scans into a collaborative, stateful puzzle assembly graph that grows smarter as pieces are placed.
* **Key Tasks**:
  1. **Grid Model in Rust (`cv-engine/src/board.rs`)**:
     - Define grid dimensions (e.g., $42 \times 24$ for 1,008-piece Ravensburger).
     - Model slots with 4 edge neighbor slots (North, East, South, West).
     - Represent board boundaries (Edges $r=0, c=0, r=R-1, c=C-1$ must have `Flat` edges).
  2. **Candidate Search Space Pruning**:
     - When scanning a **Corner** piece, candidate positions shrink immediately from 1,008 to **4**.
     - When scanning a **Border** piece, candidate positions are restricted to the 128 perimeter cells.
     - As pieces are locked into place, open boundary constraints propagate to remaining empty neighbor cells.
  3. **Virtual Board UI Component (`web-app/src/components/BoardView.tsx`)**:
     - Interactive zoomable/pannable 2D canvas displaying the puzzle grid.
     - Highlights placed pieces, candidate slots for current piece, and fit probability scores.

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
