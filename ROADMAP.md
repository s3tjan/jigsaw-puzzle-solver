# Jigsaw Puzzle Solver: Technical Architecture & Roadmap

This document defines the mathematical strategy, physical constraints, computer vision pipeline, milestone tracker, and phase specifications for solving a 1,008-piece physical jigsaw puzzle using **Rust**, **WebAssembly (WASM)**, and **Angular (TypeScript)**.

---

## 1. Physical Reality & Core Operating Constraints

Physical jigsaw puzzle assembly via an overhead camera and WebAssembly operates under strict physical and optical realities:

1. **Failure of the 60-Year Forward Paradigm**: Academic literature and hobbyist apps attempt a forward search: $\text{Piece} \to \text{Location}$. In physical reality, an isolated piece with low spatial entropy (sky, foliage) produces diffuse correlation clouds, and random sampling from a box of 880 remaining pieces has a $<0.2\%$ chance of fitting where you are currently working.
2. **Die Repeatability (Identical Twins)**: Commercial manufacturers stamp 1,000-piece puzzles using repeating dies (e.g., 250 pieces repeated 4 times). Pure contour geometry cannot distinguish between identical die twins on opposite sides of the puzzle.
3. **Cardboard Kerf, Bevel & Shadow Noise**: Die-cut edges produce 1–3 pixel variations under ambient lighting, cardboard fiber fraying, and knife wear. Mating algorithms cannot expect bitwise identical edge curves or color continuity across seams.
4. **The Physical Retrieval Bottleneck**: Knowing that "Piece #342" belongs in a slot is useless if the user must rummage through a pile of 1,000 unsorted physical pieces to find it.
5. **The Inverted Paradigm (Reverse Retrieval)**: Rather than asking *"Where does this random piece go?"*, the system flips the workflow: the human anchors the physical border ($34 \times 26$ grid), selects a specific target slot on the active frontier, and queries the database: *"Which physical piece belongs in this hole?"*

---

## 2. Theoretical Framework: The Four Foundational Pillars

To transform the problem from an intractable graph optimization into an authoritative, robust human-machine system, the architecture rests on four foundational pillars:

### Pillar 1: The Formal Engine — "Frontier Constraint Query Language" (FCQL)
Instead of treating pieces as unconstrained floating visual templates, the puzzle board is modeled as a **spatial database** where each open frontier cell acts as a multi-attribute SQL-like query:

```sql
SELECT piece_id, tray_bin, recommended_rotation
FROM piece_inventory
WHERE status = 'UNPLACED'
  AND left_edge_polarity   = COMPLEMENT(board.slot[R, C-1].right_edge)   -- e.g. HOLE
  AND top_edge_polarity    = COMPLEMENT(board.slot[R-1, C].bottom_edge)  -- e.g. TAB
  AND metric_tab_width_mm  ≈ board.slot[R-1, C].tab_width ± 0.4mm
ORDER BY 
  cielab_similarity(piece.artwork, poster.slot[R, C]) * 0.6 +
  sobel_gradient_alignment(piece.gradients, poster.slot[R, C]) * 0.4
LIMIT 3;
```
* **Bitmask Pruning (<0.01ms)**: Edge polarities (`Flat=00`, `Tab=01`, `Hole=10`) filter out ~75–90% of candidate pieces via instant bitwise operations across all 4 cardinal rotations before computing pixel similarities.
* **Metric Verification**: Calibrated millimeter sizing rejects dimensionally impossible candidates without brittle curve registration.

### Pillar 2: The Physical Bridge — Continuous Entropy Reduction & Smart Trays
Academic systems fail in the real world because the computer has no awareness of where physical objects sit in the room. The physical bridge ensures every physical user action systematically decreases system entropy:
* **Zero-Friction Ingestion with Dynamic Binning**: As pieces drop on the camera mat (~2s per piece), WASM classifies coarse color/quadrant profiles and flashes a tray badge (e.g., 🟦 Sky, 🟩 Forest, 🟥 Barn). The user drops the piece into that labeled physical tray.
* **The Visual Spotting HUD**: When an empty slot is queried, the UI presents a **Spotting Card** indicating the exact tray, orientation, and a **1:1 physical millimeter scale silhouette** that can be visually compared to the physical piece in seconds.

### Pillar 3: Frontier Entropy Scheduling (The Algorithm Directs the Human)
Rather than forcing the human to guess which slot to tackle next, the engine calculates the **Information Gain** across all open frontier cells:
$$\text{Slot Confidence} = \text{Top Candidate Score} - \text{Second Candidate Score}$$
* **Corner & High-Constraint Slots**: Frontier slots flanked by 2 or 3 placed neighbors have rigid complementary edge constraints, yielding deterministic single-candidate matches (99.9% certainty).
* **The "Guided Path" Mode**: The UI highlights the frontier slot with the highest confidence gap: *"Next best move: Slot (14, 8) has only 1 matching piece in your Green Tray."*

### Pillar 4: Fault Tolerance & The "Snap-to-Validate" Loop
In academic greedy solvers, a single misassigned piece breaks all subsequent steps. Our human-in-the-loop paradigm guarantees self-correction:
* **Physical Validation as Ground Truth**: The human snaps the physical cardboard piece into place. If it clicks cleanly, they confirm in the UI. If it feels tight or wrong, they tap **Reject**; the system down-ranks that candidate and offers the next best candidate without corrupting the board coordinate space.
* **Reverse State Synchronization**: If the user assembles a small 2–3 piece cluster on the table by eye, they can scan the cluster together. The system matches the composite shape against the poster and locks the entire cluster into the board state simultaneously.

---

## 3. End-to-End System Architecture

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
      [ STAGE 1: UPFRONT SCANNING & DYNAMIC PHYSICAL TRAY BINNING ]
        • Adaptive Otsu Binarization + 3-pass Binomial Gaussian Smoothing
        • Sub-pixel Corner Detection & 4-Edge Polarity Classification (Tab/Hole/Flat)
        • Metric Millimeter Sizing & Clean Contour-Masked Artwork Extraction
        • Coarse Color/Quadrant Classification ➔ Suggests Physical Tray (e.g., 1 of 5 Trays)
        • Audio Chime & Visual Tray Flash (Fast ~2s/piece continuous feed)
        • 100% of pieces indexed in IndexedDB + physically pre-sorted
                                |
                                v
               [ STAGE 2: PHYSICAL BORDER ANCHORING ]
        • User assembles the physical border on table (124 pieces, 34×26 grid)
        • Grounds global physical coordinate frame [R ∈ 0..25, C ∈ 0..33]
        • Initializes Board State Frontier: all 120 inner perimeter edges indexed
                                |
                                v
     [ STAGE 3: REVERSE TARGET-SLOT QUERY (Slot ➔ Candidate Pieces) ]
        • User taps target frontier slot on interactive board workbench
        • Frontier Polarity Filter: Hard bitmask match against adjacent placed neighbors
        • Metric Compatibility: Soft tab/hole width millimeter score (±0.4mm)
        • Poster Visual Correlation: Compares candidate artwork against target poster cell
        • Candidate Spotting Card: Displays Top 1–3 pieces with 1:1 scale silhouette, 
          rotation advice, and target physical tray location
                                |
                                v
               [ STAGE 4: SNAP CONFIRMATION & ADVANCE ]
        • User grabs candidate piece from designated tray, snaps physically into table
        • Click-to-Confirm updates remaining board occupancy & advances frontier
```

---

## 4. The 3-Step Inverted Assembly Workflow

```
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 1: UPFRONT SCANNING WITH DYNAMIC PHYSICAL BINNING                 │
│ • Slide pieces one-by-one under close-up camera mat (chime every ~2s). │
│ • Extract sub-pixel contour, edge polarities (Tab/Hole), & CIELAB art. │
│ • UI flashes target physical tray (e.g., 🟦 Sky, 🟩 Forest, 🟥 Barn).   │
│ • User drops piece into designated tray.                               │
│ • Result: 100% of pieces digitized AND physically pre-sorted.          │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 2: MANUAL BORDER ASSEMBLY (Physical Frame Anchoring)              │
│ • User manually builds the 124-piece border loop on the physical table.│
│ • Bypasses brittle automated 1D seam loop chaining and error cascade.  │
│ • Establishes definitive 34 × 26 physical grid frame.                  │
│ • UI indexes initial assembly frontier (exposed inner boundary tabs).  │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ STEP 3: REVERSE TARGET-SLOT QUERY (Target Slot ➔ Pick from Tray)       │
│ • User picks an area to assemble and taps a frontier slot on screen.   │
│ • Polarity Bitmask Filter: Eliminates ~75% of incompatible pieces.     │
│ • Visual Patch Retrieval: Evaluates CIELAB/Sobel against poster cell.  │
│ • UI Spotting Card: "Look in 🟥 Barn Tray for Piece #142 (Tab-Up)".   │
│ • User easily spots piece in small tray of ~150 pieces, snaps into     │
│   table, and confirms in UI to advance the frontier.                   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Milestone Status

| Phase | Milestone | Tech Stack | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Rust + WASM Scaffolding | Cargo, wasm-pack | **DONE** |
| **Phase 1** | Real-time Camera Feed & Frame Ingestion | WebRTC, Canvas, WASM Memory | **DONE** |
| **Phase 2** | 100mm Calibration Mat & 3x3 Homography | Rust (`homography.rs`), Canvas | **DONE** |
| **Phase 3** | Sub-pixel Contour Extraction & 4-Edge Classification | Rust (`contour.rs`), 90 Fixtures | **DONE** |
| **Phase 4** | Zero-Lag Sampling & Audio Detection Chime | Web Audio API, Stability Consensus | **DONE** |
| **Phase 5** | Reference Poster Ingestion & Metric Grid Setup | WASM Pyramids, CLAHE, CIELAB | **DONE** |
| **Phase 6** | Frontend Modernization: Angular Architecture Reset | Angular (Standalone, Signals, Services) | **CURRENT** |
| **Phase 7** | Dynamic Tray Binning & Rapid Upfront Ingestion Scanner | Angular (`ScannerFeature`), Web Audio | ⏳ Planned |
| **Phase 8** | Frontier Constraint Query Engine (Slot ➔ Piece Retrieval) | Rust WASM (`poster.rs`, `board.rs`) | ⏳ Planned |
| **Phase 9** | Interactive Workbench & Physical Spotting HUD | Angular (`WorkbenchFeature`), Canvas | ⏳ Planned |

---

## 6. Phase Specifications

### Phase 6: Frontend Modernization: Angular Architecture Reset (Current)
* **Architecture Pivot (ADR-003)**: Deprecate the legacy monolithic React client (`App.tsx`) and rebuild as an enterprise-grade standalone Angular application.
* **Service Decoupling**: Encapsulate WASM memory inside `WasmService`, hardware camera loops in `CameraService`, IndexedDB storage in `StorageService`, and state in Angular Signals (`InventoryStore`, `BoardStore`).
* **Clean Domain Features**: Isolate `WorkbenchFeature` (canvas pan/zoom, interactive slot query), `ScannerFeature` (100mm mat staging, fiducials, K1 calibration, tray binning), and `PosterFeature` (reference poster upload & resident WASM pyramids).

### Phase 7: Dynamic Tray Binning & Rapid Upfront Ingestion Scanner (Planned)
* **Continuous Ingestion Mode**: Optimize the camera mat loop for rapid consecutive piece drops with instant audio chime confirmation.
* **Coarse Semantic/Color Binning**: Evaluate incoming piece CIELAB color profile against 4–6 coarse poster clusters/quadrants (e.g., Sky, Vegetation, Structures, Dark Ground).
* **Tray Assignment Display**: Flash clear color/name badge on screen (and optional distinct sound) directing the user to drop the piece into physical Tray 1–6.
* **Complete Inventory Persistence**: Store 1,008 pieces with normalized contour vectors, 4-edge polarity tags (`0b00` Flat, `0b01` Tab, `0b10` Hole), metric dimensions, and clean artwork thumbnails in IndexedDB.

### Phase 8: Frontier Constraint Query Engine (Slot ➔ Piece Retrieval) (Planned)
The reverse query engine evaluates open target slots against the scanned piece inventory in $<2\text{ ms}$ in Rust WASM:

1. **Frontier Edge Indexing**:
   - Track all open slots adjacent to placed pieces.
   - For a target slot $(R, C)$, compute required complementary edge polarities (e.g., if $(R, C-1)$ has a Tab on the right, $(R, C)$ *must* have a Hole on the left).
2. **Hard Polarity Bitmask Filtering**:
   - Filter the 1,008-piece inventory using discrete edge polarity bitmasks across all 4 cardinal rotations.
   - Instantly discards ~75–90% of candidate pieces before computing pixel similarity.
3. **Multimodal Visual & Metric Ranking**:
   - Compare remaining candidates against the reference poster cell at $(R, C)$ using 4×4 spatial CIELAB descriptors and Sobel gradient orientation histograms.
   - Apply soft metric penalty for tab/hole millimeter width mismatches.
   - Output ranked candidate list with confidence score and recommended rotation $k \in \{0, 1, 2, 3\}$.

### Phase 9: Interactive Workbench & Physical Spotting HUD (Planned)
* **Frontier Slot Selection**: User taps an empty frontier slot on the 34×26 board grid.
* **Candidate Spotting Card**:
  - Displays Top 1–3 candidate piece artwork cards.
  - Highlights physical tray location (e.g., "Look in 🟥 Red Barn Tray").
  - Renders 1:1 physical millimeter scale silhouette for rapid physical visual verification.
* **Slot Confirmation & Frontier Update**:
  - User confirms physical placement; system marks piece as `PLACED`, updates remaining occupancy, and exposes newly accessible frontier slots.
  - Conflict resolution allows undoing or reassigning a slot if a physical mismatch occurs.

---

## 7. Visual Standards for the Assembly Board

To ensure the board view is a clean, practical assembly tool:
1. **Contour-Masked Piece Artwork**: Pixels outside the piece contour are masked transparent. Upright cardinal alignment, aspect-ratio preserved, zero CV lines or green corner dots.
2. **Pan / Zoom Isolation**: Mouse movement during drag/pan $>3\text{ px}$ prevents accidental slot selection.
3. **Clean Spotting Cards**: Focused modal or side drawer showing target slot candidates without cluttering the global board canvas.
4. **Streamlined Calibration**: Lens K1 distortion and calibration controls live exclusively in the full-screen modal; the main workbench remains completely free of optical debug sliders.


