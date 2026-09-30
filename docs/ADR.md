# Architecture Decision Record (ADR)

## ADR-001: Ground Truth Dataset Strategy, Edge-Corner Synchronization & Iterated Contour Smoothing

- **Status:** Accepted
- **Date:** 2026-09-30
- **Context:** CV Engine Stabilization, Edge Baseline Consistency, and Contour Smoothness for Phase 6 Curve Mating

---

### 1. Context & Problem Statement

During validation of scanned puzzle pieces in the WebAssembly computer vision engine (`cv-engine`), two prevailing issues were identified:
1. **Edge-to-Corner Chord Wobble**: Corner points undergo sub-pixel line-intersection refinement, but edge models (`PieceEdge`) retained unrefined raw contour points as their starting/ending vertices, causing chord baseline divergence and visual boundary vibration.
2. **Contour Step Roughness**: Single-pass 5-point smoothing on integer raster contours from Moore-Neighbor tracing left discrete staircase artifacts (~0.16px average 2nd-derivative directional jerk), degrading curve-mating invariance.
3. **Dataset Ingestion Uncertainty**: The user archived historical ground-truth fixtures at `datasets/archive/v1` (90 pieces) and established an empty `datasets/ground_truth/` directory for active failure capture. It was necessary to determine whether manual relabeling of the 90 archived pieces was required to fix corner reliability (90–95%) and edge wobble.

---

### 2. Decision Drivers

- **Zero-Cloud & High Performance**: All CV operations must execute deterministically inside browser WebAssembly at ~60 FPS with minimal memory allocation.
- **Geometric Rigor**: `ScannedPiece.corners` and each `PieceEdge` baseline must be mathematically identical and collinear with the physical corners.
- **Curve-Matching Compatibility (Phase 6)**: Boundary curves require continuous sub-pixel smoothness (< 0.11px directional roughness) without rounding off sharp corners.
- **Developer & Labeling Efficiency**: Avoid redundant manual labeling when existing human ground-truth labels already satisfy statistical benchmark requirements.

---

### 3. Decisions & Implementation

#### 3.1 Dataset Roles: Active Ground Truth vs. Archive v1
- **Archive (`datasets/archive/v1/`)**: Retained as the frozen regression baseline containing 90 human-labeled physical piece fixtures (`corners`, `expected_type`, `expected_edges`). Re-labeling or retrofitting `detected_corners` onto legacy archive fixtures is **not required**, because the benchmark test verifies live detector output against the verified human label.
- **Active Capture (`datasets/ground_truth/`)**: Dedicated to new or problematic pieces frozen from the live labeling UI. New fixtures record both `corners` (human label) and `detected_corners` (pre-correction CV detector state).

#### 3.2 Edge-Corner Endpoint Synchronization
- In `cv-engine/src/contour.rs`, each `PieceEdge` in `ScannedPiece.edges` directly receives the sub-pixel refined corners:
  ```rust
  edges[i].start_corner = corners[i];
  edges[i].end_corner = corners[(i + 1) % 4];
  edges[i].curve_samples[0] = corners[i];
  edges[i].curve_samples[last] = corners[(i + 1) % 4];
  ```
- This guarantees zero discrepancy between the piece's corner vertices and edge chord boundaries.

#### 3.3 Iterated Binomial Gaussian Contour Smoothing
- Upgraded `smooth_contour_points()` to execute 3 iterative passes of a 5-point binomial Gaussian filter (`[1, 4, 6, 4, 1] / 16`).
- Reduces local integer pixel step noise to `< 0.09px` mean directional jerk (well under the 0.11px budget), ensuring smooth continuous derivative calculation for turn-angle cross-correlation in Phase 6.

#### 3.4 Automated Wobble & Smoothness Test Harness
- Created `cv-engine/tests/test_wobble_smoothness.rs` to assert:
  1. `test_edge_endpoint_corner_consistency`: 0 endpoint discrepancies across all piece edges.
  2. `test_contour_smoothness_and_wobble_budget`: 0 contours exceeding the 0.11px roughness budget.

---

### 4. Consequences

#### Positive
- **Zero Baseline Wobble**: Rendered wireframe chords and edge measurements now perfectly anchor to the sub-pixel corner pins.
- **Smooth Continuous Signatures**: Contour noise is reduced by over 40%, preventing false local extrema in turn-angle $\theta(s)$ curve signatures.
- **Preserved Existing Ground Truth**: 90 verified physical piece fixtures remain valid without manual re-annotation work.
- **Continuous CI Validation**: Any change that re-introduces corner-edge discrepancy or contour roughness immediately fails `cargo test`.

#### Negative / Trade-offs
- Iterated smoothing runs 3 passes instead of 1, adding ~0.05ms of WASM compute per piece frame, which is negligible against the 160ms analysis cadence.
