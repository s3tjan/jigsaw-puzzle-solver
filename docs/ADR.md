# Architecture Decision Records (ADRs)

This document records key architectural decisions, rationale, trade-offs, and physical validation results for the Jigsaw Puzzle Solver project.

---

## ADR-001: Sub-pixel Contour Extraction, Iterated Binomial Smoothing & Curvature-Guided Corner Detection

- **Status:** Accepted
- **Date:** 2026-10-02
- **Context:** Raw Otsu binarization produces jagged 1-pixel staircase boundaries on high-resolution camera feeds, causing severe noise in normal vector calculations, chord lengths, and corner detection.

### 1. Decision & Implementation
- Replace simple box filter smoothing with 3-pass Binomial Gaussian smoothing on the binary edge chain.
- Use arc-length parameterized turn-angle profiles $\theta(s)$ with sub-pixel local maxima suppression to detect the 4 true physical corners.
- Segment piece perimeter into 4 distinct edge profiles normalized to 100 equidistant arc-length samples.

### 2. Consequences
- Eliminates camera sensor discretization noise.
- Provides consistent classification of edge polarity (Tab, Hole, Flat).
- Adds minimal compute overhead (~0.05ms in WASM), well within the real-time frame budget.

---

## ADR-002: Inverted Frontier Constraint Query Engine & Dynamic Physical Tray Binning

- **Status:** Accepted (Supersedes Automated 1D Perimeter Loop Chaining & Forward Random-Draw Heatmaps)
- **Date:** 2026-10-06
- **Context:** Automated pairwise seam interlocking achieves only 30–40% reliability across physical puzzle pieces due to repeated die patterns, edge fraying/bevel noise, and greedy error accumulation. Furthermore, forward random-draw scanning ("where does this random piece go?") generates diffuse, ambiguous heatmaps across low-entropy regions (sky/foliage) and creates a physical search bottleneck.

---

### 1. Context & Problem Statement

Physical tabletop validation revealed fundamental limitations in both automated 1D seam chaining and forward random piece search:
1. **Die Repetition & Identical Twins**: Commercial 1,000-piece puzzles repeat identical die cut lines across multiple quadrants. Contour curves alone cannot distinguish identical cuts on opposite sides of the puzzle.
2. **Cardboard Fraying & Seam Noise**: Ambient shadows, cardboard edge wear, and print bleed introduce color discontinuities (elevated $\Delta E$) and physical micro-variations ($1\text{--}3\text{ px}$) along cut seams, frequently breaking pairwise matches.
3. **The Single-Piece Forward Trap**: Pulling a random piece from the box and evaluating $P(R, C \mid \text{piece})$ yields diffuse probability clouds across monotone regions. Furthermore, random sampling from 880 remaining pieces has a $<0.2\%$ chance of fitting the active area the user is currently assembling.
4. **The Physical Retrieval Bottleneck**: Predicting where "Piece #342" belongs is useless if the user must rummage through an unsorted pile of 1,000 physical cardboard pieces.

---

### 2. Decisions & Implementation

#### 2.1 The Inverted 3-Step Practical Workflow
1. **Upfront Ingestion with Dynamic Tray Binning**:
   - Slide pieces under the camera mat (~2s/piece continuous feed with audio chime).
   - Extract sub-pixel contour, 4-edge polarity classification (Tab, Hole, Flat), metric millimeter measurements, and clean artwork.
   - WASM classifies incoming pieces into 4–6 coarse color/quadrant clusters and indicates a designated physical tray (e.g., 🟦 Sky, 🟩 Forest, 🟥 Barn).
   - 100% of pieces are indexed in IndexedDB and physically pre-sorted on the table.
2. **Manual Physical Border Assembly**:
   - The user manually constructs the 124-piece rectangular frame on the table.
   - Effortlessly grounds the global 34 × 26 physical coordinate frame and initializes the active assembly frontier (all 120 inner perimeter edges indexed).
3. **Reverse Target-Slot Query (Slot ➔ Candidate Retrieval)**:
   - The user taps an empty frontier slot $(R, C)$ on the interactive board workbench.
   - **Hard Polarity Bitmask Filtering**: The query engine matches complementary polarities against adjacent placed neighbors, pruning 75–90% of candidates in $<0.01\text{ ms}$.
   - **Visual & Metric Correlation**: Correlates candidate artwork against the target poster cell using 4×4 spatial CIELAB and Sobel gradient descriptors in Rust WASM ($<2\text{ ms}$).
   - **Spotting HUD**: Displays a Spotting Card with Top 1–3 candidates, 1:1 scale silhouette, rotation advice, and designated physical tray name.
   - The user grabs the piece from the small tray (~150 pieces), snaps it into the table, and confirms in the UI to advance the frontier.

#### 2.2 Board State Frontier & Occupancy Tracking
- Click-to-confirm updates remaining board occupancy and indexes newly exposed boundary tabs and holes on the assembly frontier.
- Conflict resolution permits instant rejection or removal if physical fitting reveals an error.

#### 2.3 UI & Canvas Standards
- **Pan vs. Click Isolation**: $>3\text{ px}$ drag threshold prevents accidental slot selection during board panning.
- **Contour-Masked Artwork**: Pieces render with clean transparent backgrounds outside the contour, oriented upright in cardinal directions.
- **Clean Spotting Cards**: Focused drawer/modal shows target slot candidates without cluttering the global board canvas with diffuse heatmaps.

---

### 3. Consequences

#### Positive
- **Deterministic Assembly**: Eliminates greedy error cascades and diffuse heatmap ambiguity by querying slots with anchored boundary conditions.
- **Solves Physical Retrieval**: Dynamic physical binning groups pieces into small trays of ~150 pieces, making physical spotting take 5–10 seconds.
- **Fast Interactive Feedback**: Bitmask + WASM poster correlation resolves slot queries in $<2\text{ ms}$.
- **Natural Human-Machine Collaboration**: Human handles border grounding and physical snapping; computer handles 1,008-piece indexing and multi-attribute constraint querying.

#### Trade-offs
- Requires an upfront scanning session of all pieces (~35–45 minutes) with coarse tray sorting prior to interior assembly.

---

## ADR-003: Frontend Architecture Pivot to Angular (Complete Replacement of web-app)

- **Status:** Accepted
- **Date:** 2026-10-04
- **Context:** The initial React frontend grew into a monolithic 3,600+ line component (`App.tsx`) with over 40 interwoven hooks managing camera streams, audio, canvas rendering, IndexedDB, and WASM memory calls. This structure became brittle, difficult to maintain, and lacked separation of concerns.

---

### 1. Decision & Implementation

1. **Complete Replacement of `web-app`**:
   - Deprecate and replace the existing React client in `web-app/` with an enterprise-grade **Angular** application (standalone components, signals, typed injectable services).
   - Archive the existing React implementation to `web-app-legacy/` prior to re-initializing `web-app/` with Angular.

2. **Decoupled Architecture with Injectable Services**:
   - **`WasmService`** (Singleton): Encapsulates WebAssembly linear memory, module initialization (`init()`), and high-performance TypedArray exchanges with `cv-engine`.
   - **`CameraService`**: Manages WebRTC device constraints, stream capture, and the requestVideoFrameCallback / requestAnimationFrame sampling loop.
   - **`AudioFeedbackService`**: Manages the Web Audio API synthesizer for piece capture chimes.
   - **`StorageService`**: Dedicated IndexedDB wrapper for persisting piece inventories and master poster descriptors.
   - **`InventoryStore` & `BoardStore`**: Reactive, signal-based state management cleanly isolating scanned pieces and 34×26 board grid occupancy.

3. **Domain-Driven Feature Modules**:
   - **`WorkbenchFeature`**: Dedicated 2D board canvas with strict pan/zoom gesture isolation, candidate heatmap glow, and piece rotation HUD.
   - **`ScannerFeature`**: Calibration mat staging modal, bullseye fiducial snapping, Lens K1 tuning, and rapid piece drop consensus.
   - **`PosterFeature`**: Master poster upload, 34×26 grid division, CLAHE preview, and resident descriptor computation.

---

### 2. Consequences

#### Positive
- **Maintainability & Scalability**: Eliminates monolithic state files; logic is split across testable, single-responsibility services.
- **Framework-Agnostic WASM Integration**: `cv-engine` compiles to standard ES modules and TypedArrays, integrating seamlessly into Angular services with zero Rust changes.
- **Productivity & Developer Velocity**: Aligns with the core expertise of the team, enabling rapid delivery of clean enterprise UI patterns.

#### Trade-offs
- Requires rewriting UI components (calibration modal, canvas pan/zoom renderer, and inventory drawer) in Angular.
