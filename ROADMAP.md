# Jigsaw Puzzle Solver: Technical Architecture & Roadmap

This document defines the mathematical strategy, physical constraints, computer vision pipeline, milestone tracker, and phase specifications for solving a 1,008-piece physical jigsaw puzzle using Rust, WebAssembly (WASM), and Angular (TypeScript).

---

## 1. Physical Reality & Core Operating Constraints

Physical jigsaw puzzle assembly via an overhead camera and WebAssembly operates under strict physical and optical realities:

1. Failure of the 60-Year Forward Paradigm: Academic literature and hobbyist apps attempt a forward search (Piece to Location). In physical reality, an isolated piece with low spatial entropy (sky, foliage) produces diffuse correlation clouds, and random sampling from a box of 880 remaining pieces has a <0.2% chance of fitting where you are currently working.
2. Die Repeatability (Identical Twins): Commercial manufacturers stamp 1,000-piece puzzles using repeating dies (e.g. 250 pieces repeated 4 times). Pure contour geometry cannot distinguish between identical die twins on opposite sides of the puzzle.
3. Cardboard Kerf, Bevel & Shadow Noise: Die-cut edges produce 1-3 pixel variations under ambient lighting, cardboard fiber fraying, and knife wear. Mating algorithms cannot expect bitwise identical edge curves or color continuity across seams.
4. The Physical Retrieval Bottleneck: Knowing that Piece #342 belongs in a slot is useless if the user must rummage through a pile of 1,000 unsorted physical pieces to find it.
5. The Inverted Paradigm (Reverse Retrieval): Rather than asking where a random piece goes, the system flips the workflow: the human anchors the physical border (34 x 26 grid), selects a specific target slot on the active frontier, and queries the database: which physical piece belongs in this hole?

---

## 2. Theoretical Framework: The Four Foundational Pillars

To transform the problem from an intractable graph optimization into an authoritative, robust human-machine system, the architecture rests on four foundational pillars:

### Pillar 1: The Formal Engine - Frontier Constraint Query Language (FCQL)
Instead of treating pieces as unconstrained floating visual templates, the puzzle board is modeled as a spatial database where each open frontier cell acts as a multi-attribute SQL-like query:

```sql
SELECT piece_id, tray_bin, recommended_rotation
FROM piece_inventory
WHERE status = 'UNPLACED'
  AND left_edge_polarity   = COMPLEMENT(board.slot[R, C-1].right_edge)
  AND top_edge_polarity    = COMPLEMENT(board.slot[R-1, C].bottom_edge)
  AND metric_tab_width_mm  ≈ board.slot[R-1, C].tab_width ± 0.4mm
ORDER BY 
  cielab_similarity(piece.artwork, poster.slot[R, C]) * 0.6 +
  sobel_gradient_alignment(piece.gradients, poster.slot[R, C]) * 0.4
LIMIT 3;
```
- Bitmask Pruning (<0.01ms): Edge polarities (Flat=00, Tab=01, Hole=10) filter out 75-90% of candidate pieces via instant bitwise operations across all 4 cardinal rotations before computing pixel similarities.
- Metric Verification: Calibrated millimeter sizing rejects dimensionally impossible candidates without brittle curve registration.

### Pillar 2: The Physical Bridge - Continuous Entropy Reduction & Smart Trays
Academic systems fail in the real world because the computer has no awareness of where physical objects sit in the room. The physical bridge ensures every physical user action systematically decreases system entropy:
- Interactive Poster Tray Tuning Studio (Human-in-the-Loop CV Priors): Rather than rigid unsupervised clustering, the user configures tray generation in the UI via intuitive computer vision priors over the 34 x 26 grid, weighting Color Dominance (CIELAB dye matching), Texture/Detail Density (Sobel gradients), and Spatial Quadrants.
- Supervised Eyedropper Centroid Seeding: User clicks prominent landmarks on the poster (e.g. Red Barn or Cobblestone Path) to lock cluster centroid seeds, forcing constrained k-means to respect human semantic landmarks.
- Capacity-Constrained Bounding: Objective balances clusters to enforce maximum physical capacity per tray (<= 180-200 pieces), preventing a single dominant color (e.g. 500 sky pieces) from overflowing a physical container.
- Live 60 FPS Grid Tinting & Volume Meter: Re-clustering runs in <2ms in Rust WASM, dynamically tinting the poster grid and displaying estimated piece counts per tray before scanning begins.
- Multi-Palette / High-Variance Fallback Tray: Pieces spanning high-contrast transitions (e.g. sharp rooflines against sky) are automatically routed to a dedicated Landmark/Transition Tray, preventing misfiling.
- Zero-Friction Ingestion with Peripheral & Audio Guidance: As pieces drop on the camera mat (~2s continuous feed), WASM classifies the piece against the tuned poster centroids. The UI flashes a saturated full-screen peripheral color border and emits a distinct musical chord pitch (earcon) per tray. The user deposits pieces into physical trays by sound and peripheral light without looking away from the mat.
- The Visual Spotting HUD: When an empty slot is queried during assembly, the UI presents a Spotting Card indicating the exact tray, orientation, and a 1:1 physical millimeter scale silhouette that can be visually compared to the physical piece in seconds.

### Pillar 3: Frontier Entropy Scheduling (The Algorithm Directs the Human)
Rather than forcing the human to guess which slot to tackle next, the engine calculates the Information Gain across all open frontier cells (Slot Confidence = Top Candidate Score minus Second Candidate Score):
- Corner & High-Constraint Slots: Frontier slots flanked by 2 or 3 placed neighbors have rigid complementary edge constraints, yielding deterministic single-candidate matches (99.9% certainty).
- The Guided Path Mode: The UI highlights the frontier slot with the highest confidence gap (e.g. "Next best move: Slot (14, 8) has only 1 matching piece in your Green Tray").

### Pillar 4: Fault Tolerance & The Snap-to-Validate Loop
In academic greedy solvers, a single misassigned piece breaks all subsequent steps. Our human-in-the-loop paradigm guarantees self-correction:
- Physical Validation as Ground Truth: The human snaps the physical cardboard piece into place. If it clicks cleanly, they confirm in the UI. If it feels tight or wrong, they tap Reject; the system down-ranks that candidate and offers the next best candidate without corrupting the board coordinate space.
- Reverse State Synchronization: If the user assembles a small 2-3 piece cluster on the table by eye, they can scan the cluster together. The system matches the composite shape against the poster and locks the entire cluster into the board state simultaneously.

---

## 3. End-to-End System Architecture & Assembly Workflow

The physical-to-digital pipeline bridges physical tabletop assembly and computer vision through four operational stages:

### Stage 1: Poster Setup & Dynamic Tray Synthesis
- Poster Ingestion: Master reference image is sliced into the canonical 34 x 26 grid (884 interior slots).
- Attribute Clustering: Unsupervised and semi-supervised clustering (k-means in CIELAB color, Sobel gradient texture, and spatial coordinates).
- Physical Tray Definition: Synthesizes 4-6 optimal physical sorting trays with capacity limits (<= 200 pcs/tray), distinct color badges, and visual swatches.

### Stage 2: Upfront Scanning & Dynamic Physical Tray Binning
- Continuous Piece Staging: User slides pieces one by one onto the close-up camera mat. The camera loop detects stability and captures each piece with an audio chime (~2 seconds per piece).
- Feature Extraction: WASM extracts sub-pixel contour vectors, 4-edge polarity tags (Tab, Hole, Flat), metric millimeter dimensions, and clean contour-masked artwork.
- Dynamic Tray Routing: The piece's CIELAB color and texture profile is matched against poster clusters. A full-screen peripheral color flash and distinct musical chord pitch (earcon) guide the user to drop the piece into the designated physical tray (e.g. Sky, Forest, Barn).
- Database Persistence: 100% of pieces are indexed in IndexedDB and physically pre-sorted on the table.

### Stage 3: Manual Border Assembly (Physical Frame Anchoring)
- Tabletop Construction: User manually snaps together the 124 border pieces on the physical table.
- Ground Truth Coordinate Frame: Establishes the global physical coordinate frame (R in 0..25, C in 0..33) effortlessly, eliminating 1D computer vision seam chaining errors and combinatorial cascades.
- Frontier Initialization: User confirms border completion in the UI; system registers border pieces as placed and indexes the 120 exposed inner perimeter tabs and holes as the initial active frontier.

### Stage 4: Reverse Target-Slot Query & Frontier Advancement
- Frontier Slot Selection: User chooses an area of interest on the table and taps an adjacent empty frontier slot (R, C) on the screen.
- Hard Polarity Bitmask Pruning: Enforces complementary edge polarities against placed neighbors, pruning 75-90% of inventory in <0.01ms.
- Visual & Metric Ranking: Remaining candidates are ranked against target poster artwork in <2ms in Rust WASM with soft metric millimeter penalties.
- Spotting Card Guidance: UI displays the top matching piece ("Look in Brick Red Tray for Piece #142 (Tab-Up)"), with a 1:1 physical millimeter scale silhouette for instant visual confirmation.
- Physical Snap & State Advance: User spots the piece in the designated tray of ~150 pieces within seconds, snaps it into the physical board, and taps Confirm to update board occupancy and advance the frontier.
- Conflict Resolution: Tapping Reject down-ranks the candidate and promotes an alternate without corrupting board coordinates---

## 4. Visual Standards for the Assembly Board

To ensure the board view is a clean, practical assembly tool:
1. Contour-Masked Piece Artwork: Pixels outside the piece contour are masked transparent. Upright cardinal alignment, aspect-ratio preserved, zero CV lines or green corner dots.
2. Pan / Zoom Isolation: Mouse movement during drag/pan >3px prevents accidental slot selection.
3. Clean Spotting Cards: Focused modal or side drawer showing target slot candidates without cluttering the global board canvas.
4. Streamlined Calibration: Lens K1 distortion and calibration controls live exclusively in the full-screen modal; the main workbench remains completely free of optical debug sliders.

---

## 5. Subsystem Task Matrix

Tasks are organized by functional subsystem and identified by namespace prefix:
- OPT: Optical & Calibration Subsystem
- CNT: Contour & Edge Classification Subsystem
- TRY: Poster Analysis & Dynamic Tray Studio Subsystem
- ING: Continuous Mat Ingestion & Storage Subsystem
- RET: Frontier Constraint Retrieval Engine (FCQL) Subsystem
- HUD: Assembly Workbench & Physical Spotting HUD Subsystem

Each task is independently verifiable through either a cv-engine unit test (cargo test -p cv-engine ...) or a visual UI inspection in the browser.

### OPT: Optical & Calibration Subsystem

| Task ID | Task Name | Domain | Description | Verification Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| OPT-01 | WebRTC 1080p Stream Ingestion | Frontend | Injectable CameraService managing media stream constraints at 1080p with 720p fallback. | UI Visual: Camera preview starts at 1080p without aspect ratio distortion. | DONE |
| OPT-02 | 100mm Target Fiducial Snapping | cv-engine | Detect 4 corners (C1-C4) of 100mm mat and compute 3x3 homography matrix in homography.rs. | Unit Test: cargo test test_homography verifies <0.2mm projection error. | DONE |
| OPT-03 | Lens K1 Radial Distortion Tuning | cv-engine / UI | Full-screen calibration modal tuning K1 parameter with live dewarped checkerboard preview. | UI Visual: Barrel distortion lines straighten interactively as K1 slider moves. | DONE |

### CNT: Contour & Edge Classification Subsystem

| Task ID | Task Name | Domain | Description | Verification Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| CNT-01 | Binomial Edge Smoothing | cv-engine | Adaptive Otsu binarization with 3-pass Binomial Gaussian smoothing in contour.rs. | Unit Test: cargo test test_wobble_smoothness confirms removal of staircase noise. | DONE |
| CNT-02 | Sub-pixel Corner Turn-Angle Detection | cv-engine | Detect 4 true physical corners using arc-length parameterized turn-angle profiles. | Unit Test: cargo test test_ground_truth verifies 4 corners detected on 90 fixtures. | DONE |
| CNT-03 | 4-Edge Polarity & Metric Millimeter Sizing | cv-engine | Segment piece into 4 edges, classify polarities (Tab, Hole, Flat), measure tab width in mm. | Unit Test: cargo test test_pairwise_matcher verifies discrete edge classifications. | DONE |

### TRY: Poster Analysis & Dynamic Tray Studio Subsystem

| Task ID | Task Name | Domain | Description | Verification Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| TRY-01 | Poster Grid Feature Vector Extraction | cv-engine | Compute 884 feature vectors V(R, C) = [L, a, b, gradient, R, C] for each poster cell in poster.rs. | Unit Test: cargo test test_poster_grid_feature_vectors verifies 884 vectors in <5ms. | Planned |
| TRY-02 | Constrained k-Means with Feature Weights | cv-engine | Implement k-means over vectors with configurable weights (w_color, w_texture, w_spatial). | Unit Test: cargo test test_weighted_kmeans_clustering verifies convergence in <20 iters. | Planned |
| TRY-03 | Capacity-Constrained Tray Balancing | cv-engine | Add penalty term bounding cluster size to <= 200 pieces, subdividing large monotone regions. | Unit Test: cargo test test_capacity_constrained_clustering verifies bounds hold. | Planned |
| TRY-04 | Supervised Eyedropper Centroid Seeding | cv-engine / UI | Allow seeding cluster centroids via user coordinates [R, C], locking semantic landmarks. | Unit Test: cargo test test_seeded_kmeans_centroids verifies anchor points stick. | Planned |
| TRY-05 | Poster Tray Tuning Studio UI | Frontend | Slider controls for weights, tray count selector (4-6), Eyedropper tool, and volume meter. | UI Visual: Adjusting sliders updates tray cards and piece count estimates at 60 FPS. | Planned |
| TRY-06 | Live 60 FPS Grid Tinting Canvas | Frontend | Render colored tint overlays on poster canvas reflecting assigned cluster IDs per grid slot. | UI Visual: Poster displays color-coded overlay matching physical tray badges. | Planned |
| TRY-07 | Landmark / Transition Fallback Tray | cv-engine | Route pieces with internal color variance above threshold to dedicated Landmark Tray. | Unit Test: cargo test test_landmark_fallback_routing confirms transition piece routing. | Planned |

### ING: Continuous Mat Ingestion & Storage Subsystem

| Task ID | Task Name | Domain | Description | Verification Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| ING-01 | StorageService & IndexedDB Schema | Frontend | Reactive IndexedDB wrapper persisting pieces, contours, assigned trays, and board state. | UI Visual: Ingesting a piece writes complete record visible in DevTools Application tab. | DONE |
| ING-02 | Continuous Piece Ingestion Loop | Frontend | Mat camera loop for consecutive piece drops with stability consensus, pause, and resume. | UI Visual: Dropping 5 pieces sequentially logs 5 entries without manual clicks. | Planned |
| ING-03 | Multi-Pitch Earcon & Peripheral Guidance | Frontend | Synthesize distinct musical chord frequency per tray and flash full-screen peripheral color. | UI Visual / Audio: Trigger plays unique pitch for Tray 1 vs 2; border flashes tray color. | Planned |
| ING-04 | Complete Inventory Persistence | Frontend | Store 1,008 pieces with normalized contour vectors, polarity bitmasks, and artwork thumbs. | UI Visual: Inventory drawer displays count 1,008 and allows filtering by tray. | Planned |

### RET: Frontier Constraint Retrieval Engine (FCQL) Subsystem

| Task ID | Task Name | Domain | Description | Verification Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| RET-01 | Board State Frontier Topology Index | cv-engine | Track active frontier slots and compile complementary edge requirements (Tab to Hole, Flat). | Unit Test: cargo test test_frontier_polarity_generation verifies neighbor edge inversion. | Planned |
| RET-02 | Hard Polarity Bitmask Filtering Engine | cv-engine | Bitmask matching (0b00, 0b01, 0b10) against 1,008 inventory pieces across 4 cardinal rotations. | Unit Test: cargo test test_bitmask_polarity_pruning verifies <0.01ms and 75-90% prune rate. | Planned |
| RET-03 | Metric Millimeter Sizing Compatibility | cv-engine | Soft score penalty for tab/hole width and chord length deviation beyond tolerance (+-0.4mm). | Unit Test: cargo test test_metric_sizing_compatibility verifies dimensional penalty. | Planned |
| RET-04 | Multimodal Poster Visual Ranking | cv-engine | Rank candidates against target poster cell using 4x4 spatial CIELAB and Sobel gradients. | Unit Test: cargo test test_target_slot_candidate_ranking confirms fixture in Top 3. | Planned |
| RET-05 | Frontier Entropy Scheduling (Best Move) | cv-engine | Compute confidence gap across open frontier cells to identify deterministic next moves. | Unit Test: cargo test test_frontier_entropy_scheduling verifies highest gap ranking. | Planned |

### HUD: Assembly Workbench & Physical Spotting HUD Subsystem

| Task ID | Task Name | Domain | Description | Verification Method | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| HUD-01 | Workbench 2D Canvas Isolated Viewport | Frontend | Pan/zoom board canvas with strict >3px drag threshold preventing accidental slot clicks. | UI Visual: Dragging pans smoothly; clicking without drag triggers slot select event. | CURRENT |
| HUD-02 | Interactive Frontier Slot Query Handler | Frontend | User click on open frontier slot triggers WASM query engine and opens spotting drawer. | UI Visual: Clicking empty slot adjacent to placed border opens candidate sidebar. | Planned |
| HUD-03 | Candidate Spotting Card & Tray Locator | Frontend | Display piece artwork, recommended rotation (0, 90, 180, 270 deg), and physical tray badge. | UI Visual: Spotting card indicates "Look in Brick Red Tray for Piece #142". | Planned |
| HUD-04 | 1:1 Scale Physical Silhouette Display | Frontend | Render piece silhouette at calibrated 1:1 physical millimeter scale on screen. | UI Visual: Placing physical piece against screen matches displayed silhouette outline. | Planned |
| HUD-05 | Click-to-Confirm & Frontier Advancement | Frontend | Confirming piece marks it PLACED, updates board occupancy, and exposes new frontier slots. | UI Visual: Board slot renders piece artwork; adjacent empty slots light up. | Planned |
| HUD-06 | Snap-to-Validate Conflict Resolution | Frontend | Reject button down-ranks candidate and reveals alternate piece; Remove button clears slot. | UI Visual: Clicking Reject immediately swaps spotting card to Candidate #2. | Planned |
| HUD-07 | Multi-Piece Island Cluster Staging | cv-engine / UI | Camera scan of 2-3 piece sub-assemblies, matching composite artwork to lock slots at once. | Unit Test / UI: Composite 2-piece fixture matches correct adjacent board slots. | Planned |

