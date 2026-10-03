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

---

## ADR-002: Multimodal Perimeter Assembly, Inward Boundary Propagation & Spatial Probability Density Heatmaps

- **Status:** Accepted
- **Date:** 2026-10-03
- **Context:** Failure of pure geometric curve matching on physical cardboard, greedy error accumulation, and the unreliability of single-piece poster matching on low-entropy interior pieces.

---

### 1. Context & Problem Statement

Physical tabletop validation revealed critical limitations in the previous assembly pipeline:
1. **Physical Die Repetition & Kerf Noise**: Commercial 1,000-piece puzzles repeat die patterns (e.g. 250-piece dies stamped 4 times). Pure contour $L_2$ curve matching cannot distinguish between identical die twins on opposite sides of the board. Cardboard bevel and directional shadows introduce 1–3 pixel variations that derail greedy curve chaining.
2. **Greedy Error Accumulation**: A single mismatched piece early in a 34-piece side chain invalidates all subsequent placements, resulting in an impossible perimeter loop that cannot physically snap together.
3. **The Single-Piece Poster Trap**: Matching isolated interior pieces directly against the reference poster produces noisy, false-positive peaks in low-entropy regions (sky, water, solid colors).
4. **Physical Labeling & Mismatch in Mental Model**: The user draws arbitrary pieces from an unlabeled box. Requiring users to find specific piece numbers in the box, or manually verify pairwise mating seams ("Piece #8 with #9"), is impractical for 1,000 physical pieces.

---

### 2. Decision Drivers

- **Physical Ground Truth**: Cardboard edges fray and cast shadows, but printed ink and metric millimeters do not. Mating pieces must have continuous color across the seam and matching millimeter dimensions ($\pm 0.3\text{ mm}$).
- **Zero Physical Labeling**: The user must be able to pull any random piece from the box and receive clear tabletop placement guidance.
- **Universal Engine (1,008-Piece Scope)**: The core 7-step mating pipeline must be mathematically and architecturally universal for all 1,008 pieces. The 124-piece border is simply an initial closed-loop validation set and rigid frame anchor; the engine must not be specialized or siloed for border pieces only.
- **Robustness Over False Precision**: The system must never present a single high-confidence coordinate for a piece when the underlying computer vision only supports a regional probability distribution.
- **Clean, Focused UI**: Eliminate clutter, debug controls, and accidental drag-placements.

---

### 3. Decisions & Implementation

#### 3.1 Multimodal Perimeter Solver (Closed Set of 124 Border Pieces)
The solver filters candidate pairs through a 7-step cascading constraint hierarchy:
1. **Edge Topology Filtering**: Enforce discrete edge polarity (Tab requires a Hole; Flat outer edges never search for mates). Cheap, fast $O(1)$ binary check.
2. **Metric Dimension Tolerances**: Reject candidate border seams whose baseline length, tab width, or tab depth differ by more than $\pm 0.3\text{ mm}$ (fast $O(1)$ dimensional check).
3. **Seam Ink Continuity (MGC)**: Measure color gradient continuity across candidate cut seams ($\text{Cost}_{\text{MGC}}$) to eliminate identical die-cutter twins from different quadrants.
4. **Sub-pixel Interlocking Contour Analysis**: Compare complementary tongue-and-groove contour curves within tolerance (normalized profile, neck width, ear roundness, and entry angle) as the decisive physical check before clustering. Discard false pairings where ink and baseline match but physical contours collide or fail mechanical fit.
5. **Mutual Best-Buddies Filtering**: Lock micro-clusters if and only if piece $A$'s #1 match is piece $B$ and piece $B$'s #1 match is piece $A$ across combined metric, ink, and contour criteria.
6. **Micro-Clusters & Global $34 \times 26$ Loop Optimization**: Assemble micro-clusters into a closed ring satisfying exact side counts (Top: 34, Right: 26, Bottom: 34, Left: 26 non-corner pieces).
7. **Frame-to-Poster Rigid Alignment**: Anchor the assembled 124-piece rectangular frame to the master reference poster with zero coordinate ambiguity.

#### 3.2 Inward Boundary Propagation & Pocket Filling for the Interior
- Rather than pre-scanning all 884 interior pieces, support an **online, streaming draw**:
  - Test dropped pieces against all currently exposed boundary seams on the board using metric millimeter dimensions, seam ink continuity, and sub-pixel interlocking contour curve fit before placing.
  - Exploit 2-edge and 3-edge pockets (e.g., corner slots like `[1, 1]`) which enforce simultaneous multi-seam mechanical locks.

#### 3.3 Spatial Probability Density Heatmaps ($P(R, C \mid I)$)
- For interior pieces that do not connect to the active boundary:
  - Do not force a single coordinate. Compute a 2D probability distribution across the $28 \times 36$ grid.
  - Render high-entropy pieces (text, faces, sharp edges) as distinct landmark island anchors.
  - Render low-entropy pieces (sky, water) as soft regional heat glows on the board.
  - When 2–3 pieces in an island zone snap together on the physical table, evaluate the connected cluster as a single multi-piece entity, multiplying spatial entropy and collapsing the diffuse heatmap into an exact coordinate.

#### 3.4 UI & Canvas Ergonomics
- **Pan vs. Click Isolation**: Apply a $>3\text{ px}$ mouse drag threshold on the board canvas to completely eliminate accidental piece placements during panning.
- **Contour-Masked Piece Rendering**: Render only piece artwork with transparent backgrounds outside the contour, oriented upright to the grid without distortion, replacing raw camera thumbnails with CV markers.
- **Calibration Consolidation**: Move Lens K1 distortion tuning into the full-screen camera calibration view, removing all lens sliders from the main workbench footer.
- **Remove Mating Pair Verification**: Completely purge manual pair approval panels and provisional seam indicators from the user workflow.

---

### 4. Consequences

#### Positive
- **Physically Reliable Perimeter**: Eliminates false die twins and greedy loop failures by combining metric tolerances, seam color continuity, and global loop closure.
- **Realistic Interior Workflow**: Eliminates the requirement to pre-scan 884 pieces while avoiding false-precision template matching.
- **Natural Tabletop Interaction**: The user pulls random pieces from the box, and the system either snaps them to the boundary, places an island anchor, or highlights the approximate regional zone.
- **Clean User Experience**: Removes UI clutter and prevents accidental board placements during navigation.

#### Negative / Trade-offs
- Computing MGC across candidate border seams requires color sampling along edge cuts in WASM, adding a lightweight pixel extraction step during border solving (~150ms for 124 pieces, acceptable for an offline solve).

