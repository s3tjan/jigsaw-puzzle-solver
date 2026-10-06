# Jigsaw Puzzle Solver: Technical Architecture & Task Matrix

A cyber-physical system for solving a 1,008-piece jigsaw puzzle (34 x 26 grid) using Rust WASM (`cv-engine`) and Angular (`web-app`).

### Core Operating Model
1. Reverse Retrieval: The user anchors the 124 border pieces, selects an empty frontier slot `(R, C)`, and queries matching pieces from inventory.
2. Dynamic Physical Trays: Pieces are pre-sorted into 4-6 balanced physical containers based on poster clustering (CIELAB color, Sobel gradients, spatial coordinates) during continuous mat ingestion.
3. Metric Calibration: 100mm fiducial mat establishes an orthographic scale anchor (`96px = 25mm`) with K1 lens distortion correction.
4. Hard Polarity Pruning: Discrete edge polarities (Flat=00, Tab=01, Hole=10) prune 75-90% of candidates via bitwise operations in <0.01ms before visual correlation.

### Prior Art Differentiation
- Forward vs. Reverse Paradigm: Academic solvers evaluate P(slot | random piece), failing on low-entropy regions (sky/foliage) and identical die-twin cuts. We invert to P(candidate | frontier slot), enforcing deterministic physical boundary conditions.
- Cyber-Physical Search Friction: Existing systems ignore physical piece retrieval in the room. By deriving capacity-constrained physical trays (<= 200 pcs) from poster analysis and using peripheral/audio cues during continuous ingestion, physical search time is reduced from minutes in a 1,000-piece pile to seconds in a small tray.

---

## Subsystem Task Matrix

Tasks are organized by functional subsystem and identified by namespace prefix:
- `OPT`: Optical Calibration & Metric Grounding
- `CNT`: Contour & Edge Classification
- `TRY`: Poster Analysis & Dynamic Tray Studio
- `ING`: Continuous Mat Ingestion & Inventory Storage
- `RET`: Frontier Constraint Retrieval Engine (FCQL)
- `HUD`: Assembly Workbench & Spotting HUD

### OPT: Optical Calibration & Metric Grounding

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| OPT-01 | - | `web-app/src/app/core/services/camera.service.ts` | Browser preview inspection | WebRTC 1080p stream ingestion with 720p fallback in `CameraService`. | DONE |
| OPT-02 | OPT-01 | `cv-engine/src/homography.rs` | `cargo test test_homography` | Detect 4 corners (C1-C4) of 100mm mat; compute 3x3 homography (<0.2mm error). | DONE |
| OPT-03 | OPT-02 | `web-app/src/app/features/scanner/calibration-modal.component.ts` | Browser modal inspection | Full-screen calibration modal tuning K1 radial distortion; main board stays free of sliders. | DONE |

### CNT: Contour & Edge Classification

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| CNT-01 | OPT-02 | `cv-engine/src/contour.rs` | `cargo test test_wobble_smoothness` | Adaptive Otsu binarization with 3-pass Binomial Gaussian smoothing. | DONE |
| CNT-02 | CNT-01 | `cv-engine/src/contour.rs` | `cargo test test_ground_truth` | Arc-length turn-angle local maxima suppression detecting 4 physical corners on 90 fixtures. | DONE |
| CNT-03 | CNT-02 | `cv-engine/src/matcher.rs` | `cargo test test_pairwise_matcher` | Segment 4 edges, classify polarities (Tab, Hole, Flat), measure tab width in mm. | DONE |

### TRY: Poster Analysis & Dynamic Tray Studio

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| TRY-01 | - | `cv-engine/src/poster.rs` | `cargo test test_poster_grid_feature_vectors` | Extract 884 feature vectors `V(R, C) = [L, a, b, gradient, R, C]` in <5ms. | Planned |
| TRY-02 | TRY-01 | `cv-engine/src/poster.rs` | `cargo test test_weighted_kmeans_clustering` | Weighted k-means clustering with configurable `w_color`, `w_texture`, `w_spatial` (<20 iters). | Planned |
| TRY-03 | TRY-02 | `cv-engine/src/poster.rs` | `cargo test test_capacity_constrained_clustering` | Capacity penalty bounding cluster sizes to <= 200 pieces per tray. | Planned |
| TRY-04 | TRY-02 | `cv-engine/src/poster.rs` | `cargo test test_seeded_kmeans_centroids` | Seed cluster centroids from user-selected poster coordinates `(R, C)`. | Planned |
| TRY-05 | TRY-03, TRY-04 | `web-app/src/app/features/poster/tray-studio.component.ts` | Browser UI inspection | Studio UI with weight sliders, tray count selector (4-6), and volume meters at 60 FPS. | Planned |
| TRY-06 | TRY-05 | `web-app/src/app/features/poster/poster-canvas.component.ts` | Browser UI inspection | Canvas tint overlay on poster grid slots matching assigned tray color badges. | Planned |
| TRY-07 | TRY-02 | `cv-engine/src/poster.rs` | `cargo test test_landmark_fallback_routing` | Route high internal-variance pieces to a dedicated Landmark/Transition tray. | Planned |

### ING: Continuous Mat Ingestion & Inventory Storage

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| ING-01 | - | `web-app/src/app/core/services/storage.service.ts` | Browser DevTools Application tab | Reactive IndexedDB schema for pieces, contours, assigned trays, and board state. | DONE |
| ING-02 | CNT-03, OPT-02 | `web-app/src/app/features/scanner/scanner.component.ts` | Browser mat drop test | Camera loop for sequential piece drops (~2s/pc) with stability consensus. | Planned |
| ING-03 | ING-02, TRY-05 | `web-app/src/app/core/services/audio-feedback.service.ts` | Browser audio/visual inspection | Audio earcon chord and full-screen peripheral color flash on piece classification. | Planned |
| ING-04 | ING-02, ING-01 | `web-app/src/app/core/state/inventory.store.ts` | Browser drawer inspection | Index all 1,008 pieces with normalized contours, polarity masks, and transparent-masked thumbs. | Planned |

### RET: Frontier Constraint Retrieval Engine (FCQL)

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| RET-01 | ING-01 | `cv-engine/src/frontier.rs` | `cargo test test_frontier_polarity_generation` | Index active frontier slots and compile complementary neighbor edge polarities. | Planned |
| RET-02 | RET-01, CNT-03 | `cv-engine/src/frontier.rs` | `cargo test test_bitmask_polarity_pruning` | Bitmask polarity filter (00, 01, 10) across 4 rotations pruning 75-90% candidates (<0.01ms). | Planned |
| RET-03 | RET-02 | `cv-engine/src/matcher.rs` | `cargo test test_metric_sizing_compatibility` | Soft score penalty for tab/hole width deviation beyond tolerance (+-0.4mm). | Planned |
| RET-04 | RET-03, TRY-01 | `cv-engine/src/query.rs` | `cargo test test_target_slot_candidate_ranking` | Rank candidates against target poster cell via 4x4 spatial CIELAB and Sobel gradients (<2ms). | Planned |
| RET-05 | RET-04 | `cv-engine/src/frontier.rs` | `cargo test test_frontier_entropy_scheduling` | Information gain scheduler identifying frontier slots with largest confidence gaps. | Planned |

### HUD: Assembly Workbench & Spotting HUD

| Task ID | Depends On | Target Path | Test Command | Description | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| HUD-01 | - | `web-app/src/app/features/workbench/workbench-canvas.component.ts` | Browser canvas pan/click inspection | 2D board canvas viewport with pan/zoom and strict >3px drag threshold isolating slot clicks. | CURRENT |
| HUD-02 | HUD-01, RET-04 | `web-app/src/app/features/workbench/workbench.component.ts` | Browser slot click inspection | Clicking frontier slot `(R, C)` triggers query engine and opens spotting drawer. | Planned |
| HUD-03 | HUD-02 | `web-app/src/app/features/workbench/spotting-card.component.ts` | Browser card inspection | Spotting card showing piece thumbnail, orientation (0, 90, 180, 270 deg), and tray badge. | Planned |
| HUD-04 | HUD-03, OPT-02 | `web-app/src/app/features/workbench/silhouette.component.ts` | Screen 1:1 physical calibration check | Render piece silhouette at calibrated 1:1 physical millimeter scale on screen. | Planned |
| HUD-05 | HUD-02 | `web-app/src/app/core/state/board.store.ts` | Browser confirm click inspection | Confirm marks piece PLACED, renders artwork in slot, and updates active frontier. | Planned |
| HUD-06 | HUD-05 | `web-app/src/app/features/workbench/workbench.component.ts` | Browser reject click inspection | Reject down-ranks candidate and presents next match; Remove resets slot state. | Planned |
| HUD-07 | HUD-05, ING-02 | `cv-engine/src/cluster_matcher.rs` | `cargo test test_cluster_matching` | Scan 2-3 piece sub-assemblies on mat, matching composite artwork to lock slots at once. | Planned |
