# Jigsaw Puzzle Solver: Technical Architecture & Task Matrix

A cyber-physical system for solving a 1,008-piece jigsaw puzzle (36 × 28 total grid, 34 × 26 interior grid) using Rust WASM (`cv-engine`) and Angular (`web-app`).

### Board Geometry & Piece Breakdown
- **Total Puzzle Pieces**: 1,008 pieces (36 columns × 28 rows)
- **Perimeter (Border Pieces)**: 124 pieces
  * Corners: 4 pieces `[(0, 0), (0, 35), (27, 0), (27, 35)]`
  * Top border: 34 pieces (Cols 1..34, Row 0, excluding corners)
  * Bottom border: 34 pieces (Cols 1..34, Row 27, excluding corners)
  * Left border: 26 pieces (Rows 1..26, Col 0, excluding corners)
  * Right border: 26 pieces (Rows 1..26, Col 35, excluding corners)
  * Total perimeter = 4 + 34 + 34 + 26 + 26 = 124 border pieces
- **Interior Pieces**: 884 pieces (34 columns × 26 rows, Cols 1..34, Rows 1..26)
  * Organized by physical polarity archetypes and single-layer flat trays to guarantee 0% sorting error.
- **Total**: 124 border + 884 interior = 1,008 pieces

### Core Operating Model (Polarity-First Directed Assembly)
1. **Deterministic Ingestion & Archetype Sorting**: Pieces pass under the camera stage once. The CV engine extracts discrete 4-edge polarities (`Flat=00`, `Tab=01`, `Hole=10`), millimeter-calibrated tab dimensions, and contrast-boosted visual thumbnails. Pieces are stored in single-layer flat trays categorized by mechanical polarity archetype (100% deterministic, zero fuzzy color mis-routing).
2. **Flexible Ground Anchoring**: The board can be anchored by anywhere from 1–4 corner pieces up to the full 124 border pieces.
3. **Minimum-Entropy Wavefront Scheduling**: Rather than guessing loose pieces against 1,008 unknown poster cells, the engine identifies the highest-constraint frontier slot (slots flanked by 2 to 3 placed neighbors) for maximum pruning power.
4. **Multi-Stage Physical Funnel**:
   * **Stage 1 (Discrete Polarity)**: Bitmask match on complementary edges (`Tab` ↔ `Hole`, `Flat` ↔ `Flat`) across 4 cardinal rotations prunes 75–95% of candidates.
   * **Stage 2 (Metric Micro-Geometry)**: Tab width and depth tolerances (±0.4mm) + piece aspect ratio prune to 2–5 candidates.
   * **Stage 3 (Poster Visual Seam)**: Target cell CIELAB and Sobel gradients act as secondary tie-breakers among remaining candidates.
5. **Physical Spotting HUD**: Since physical pieces do not have numbers, the HUD presents an unmistakable visual spotting card:
   * **Exaggerated Silhouette**: Distinctive mechanical signature with millimeter callouts (e.g. "Wide Tab 5.4mm", "Off-center Tab +1.8mm").
   * **Contrast-Enhanced Crop**: High-pass / dynamic-range boosted real piece photo revealing subtle ink gradients and textures.
   * **Cardinal Orientation Arrow**: High-contrast directional banner (e.g. `▲ TAB UP (000°)`).

---

## Subsystem Task Matrix

Tasks are organized by functional subsystem and identified by namespace prefix:
- `OPT`: Optical Calibration & Metric Grounding
- `CNT`: Contour & Edge Classification
- `ING`: Continuous Mat Ingestion & Inventory Storage
- `RET`: Frontier Constraint Retrieval Engine (FCQL)
- `HUD`: Assembly Workbench & Spotting HUD
- `LEG`: Legacy Decommissioning & Technical Cleanup

### OPT: Optical Calibration & Metric Grounding

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| OPT-01 | - | `web-app/src/app/core/services/camera.service.ts` | Browser preview inspection | WebRTC 1080p stream ingestion with 720p fallback in `CameraService`. | DONE |
| OPT-02 | OPT-01 | `cv-engine/src/homography.rs` | `cargo test test_homography` | Detect 4 corners (C1-C4) of 100mm mat; compute 3x3 homography (<0.2mm error). | DONE |
| OPT-03 | OPT-02 | `web-app/src/app/features/optics/optics-calibration.component.ts` | Browser UI inspection | Dedicated Optics view (`[OPTICS Alt+2]`) tuning K1 radial distortion, focus MTF, and fiducial pins; no modals or popups. | DONE |

### CNT: Contour & Edge Classification

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| CNT-01 | OPT-02 | `cv-engine/src/contour.rs` | `cargo test test_wobble_smoothness` | Adaptive Otsu binarization with 3-pass Binomial Gaussian smoothing. | DONE |
| CNT-02 | CNT-01 | `cv-engine/src/contour.rs` | `cargo test test_ground_truth` | Arc-length turn-angle local maxima suppression detecting 4 physical corners on 90 fixtures. | DONE |
| CNT-03 | CNT-02 | `cv-engine/src/matcher.rs` | `cargo test test_pairwise_matcher` | Segment 4 edges, classify polarities (Tab, Hole, Flat), measure tab width in mm. | DONE |

### ING: Continuous Mat Ingestion & Inventory Storage

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| ING-01 | - | `web-app/src/app/core/services/storage.service.ts` | Browser DevTools Application tab | Reactive IndexedDB schema for pieces, contours, polarity archetypes, and board state. | DONE |
| ING-02 | OPT-01, ING-01 | `web-app/src/app/features/scanner/ingestion-scanner.component.ts` | Browser mat drop test | Continuous mat ingestion UI with rectified 96mm stage arena, Space-bar drop triggering, and IndexedDB piece indexing. | DONE |
| ING-02B| CNT-03, OPT-02 | `cv-engine/src/lib.rs` | `cargo test test_ingest_mat_piece` | **cv-engine WASM Ingestion Bridge**: Expose `ingest_mat_piece` WASM binding linking camera frame to Rust homography unwarp, contour extraction, 4-edge polarity segmentation, and mechanical archetype routing. | DONE |
| ING-03 | ING-02 | `web-app/src/app/features/scanner/ingestion-scanner.component.ts` | Browser audio/visual inspection | Ingestion feedback banner with polarity archetype badge (Border, 2-Tab Opp, 2-Tab Adj, etc.) for deterministic sorting. | DONE |
| ING-04 | ING-02, ING-01 | `web-app/src/app/core/state/inventory.store.ts` | Browser drawer inspection | Index all 1,008 pieces with normalized contours, polarity masks, and transparent-masked thumbs. | DONE |
| ING-05 | ING-02B, CNT-02 | `web-app/src/app/features/scanner/ingestion-scanner.component.ts` | `cargo test test_ground_truth` | Interactive ground-truth benchmark workbench: draggable C0..C3 corner refinement, manual polarity overrides, and direct fixture export to `datasets/ground_truth/`. | DONE |

### RET: Frontier Constraint Retrieval Engine (FCQL)

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| RET-01 | ING-01 | `cv-engine/src/frontier.rs` | `cargo test test_frontier_polarity_generation` | 36×28 board representation, arbitrary anchor seeding, and dynamic compilation of complementary neighbor polarities (`Tab` ↔ `Hole`, `Flat` ↔ `Flat`). | DONE |
| RET-02 | RET-01, CNT-03 | `cv-engine/src/frontier.rs` | `cargo test test_bitmask_polarity_pruning` | Bitmask polarity filter across 4 cardinal rotations ($0^\circ, 90^\circ, 180^\circ, 270^\circ$) pruning 75–95% of candidates (<0.01ms). | DONE |
| RET-03 | RET-02 | `cv-engine/src/matcher.rs` | `cargo test test_metric_sizing_compatibility` | Micro-geometry filter evaluating tab width (±0.4mm), protrusion depth, and piece aspect ratio. | Planned |
| RET-04 | RET-03 | `cv-engine/src/query.rs` | `cargo test test_target_slot_candidate_ranking` | Secondary candidate ranking against target poster cell via local CIELAB and Sobel gradients. | Planned |
| RET-05 | RET-04 | `cv-engine/src/frontier.rs` | `cargo test test_frontier_entropy_scheduling` | Minimum-entropy scheduler prioritizing frontier slots with maximum neighbor constraints. | Planned |

### HUD: Assembly Workbench & Spotting HUD

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| HUD-01 | - | `web-app/src/app/features/workbench/components/workbench-canvas/workbench-canvas.component.ts` | Browser canvas pan/click inspection | 2D board canvas viewport (36×28 full grid / 1,008 slots) rendering grid boundaries, placed pieces, and active frontier slots. | DONE |
| HUD-02 | HUD-01, RET-01 | `web-app/src/app/features/workbench/workbench.component.ts` | Browser slot click inspection | Active slot selection triggers FCQL retrieval engine and surfaces top matches. | DONE |
| HUD-03 | HUD-02 | `web-app/src/app/features/workbench/components/spotting-hud/spotting-hud.component.ts` | Browser card inspection | Visual Spotting Card displaying piece photo, archetype badge, mm tab measurements, and cardinal orientation arrow (`▲ TAB UP`). | DONE |
| HUD-04 | HUD-03, OPT-02 | `web-app/src/app/features/workbench/components/spotting-hud/spotting-hud.component.html` | Screen 1:1 physical calibration check | Render piece silhouette frame with metric grounding (25mm = 96px) and distinctive contour callouts. | DONE |
| HUD-05 | HUD-02 | `web-app/src/app/core/state/board.store.ts` | Browser confirm click inspection | Confirm placement action commits piece, dynamically expands frontier queue, and recommends next lowest-entropy slot. | DONE |
| HUD-06 | HUD-05 | `web-app/src/app/features/workbench/components/spotting-hud/spotting-hud.component.html` | Browser reject click inspection | Reject candidate button cycles candidate rankings for alternate piece selection. | DONE |
| HUD-07 | HUD-05, ING-02 | `cv-engine/src/cluster_matcher.rs` | `cargo test test_cluster_matching` | Scan 2-3 piece sub-assemblies on mat, matching composite geometry to lock multiple slots at once. | Planned |

### LEG: Legacy Decommissioning & Technical Cleanup

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| LEG-01 | RET-01 | `cv-engine/src/` | `cargo test` | Purge deprecated standalone poster-only global locator (`locate_piece_spatial` / `locate_piece_spatial_core`) that caused low-entropy collapse and false cosine inflation. | Planned |
| LEG-02 | ING-02B | `cv-engine/src/lib.rs` | `cargo test test_ingest_mat_piece` | Remove fuzzy poster-color tray routing from `ingest_mat_piece` in favor of deterministic polarity archetype classification. | Planned |
| LEG-03 | HUD-03 | `web-app/src/` | `ng test` | Remove obsolete tray clustering studio UI and obsolete color-only routing services (`PosterClusteringService`). | Planned |
