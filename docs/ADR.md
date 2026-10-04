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

## ADR-002: Spatial Probability Density Heatmaps & Tabletop Assembly Synergy

- **Status:** Accepted (Supersedes Automated 1D Perimeter Loop Chaining)
- **Date:** 2026-10-04
- **Context:** Automated pairwise seam interlocking (MGC seam ink and contour L2 matching) achieves only 30–40% reliability across physical puzzle pieces due to repeated die patterns, edge fraying/bevel noise, print bleed, and greedy error accumulation.

---

### 1. Context & Problem Statement

Physical tabletop validation across the 124 border pieces revealed fundamental limitations in automated 1D seam chaining:
1. **Die Repetition & Identical Twins**: Commercial 1,000-piece puzzles repeat identical die cut lines across multiple quadrants. Contour curves alone cannot distinguish identical cuts on opposite sides of the puzzle.
2. **Cardboard Fraying & Seam Noise**: Ambient shadows, cardboard edge wear, and print bleed introduce color discontinuities (elevated $\Delta E$) and physical micro-variations ($1\text{--}3\text{ px}$) along cut seams, frequently breaking rank #1 mutual best-buddy matches.
3. **Greedy Error Accumulation**: A single mismatched pair or swapped twin derails the entire 124-piece closed perimeter loop.
4. **Impractical User Overhead**: Demanding that users find specific piece pairs or wait for a fully automated physical perimeter loop prevents fluid assembly.

---

### 2. Decisions & Implementation

#### 2.1 Three-Step Practical Workflow
1. **Upfront Ingestion**: Scan all pieces rapidly using automated camera capture with audio detection chime. Extract clean contour-masked artwork, 4-edge polarity classification (Tab, Hole, Flat), and metric millimeter measurements.
2. **Manual Physical Border Assembly**: The user manually constructs the 124-piece rectangular frame on the table. This effortlessly grounds the global 34 × 26 physical coordinate frame without fragile computer vision loop solvers.
3. **Random Draw & Candidate Heatmaps**:
   - The user pulls any random piece from the box and stages it on the camera mat.
   - Rust WASM computes candidate slot probabilities $P(R, C \mid \text{piece})$ in <3ms using 4×4 spatial descriptors, CIELAB color profiles, and Sobel gradient orientation histograms (`poster.rs`).
   - Occupancy masking filters out already-placed slots; edge topology filters eliminate invalid perimeter vs. interior locations and incompatible frontier tab/hole polarities.
   - The UI displays a soft translucent candidate heatmap overlay on the board canvas with rotation recommendation.

#### 2.2 Board State Frontier & Occupancy Tracking
- The user clicks/taps to confirm piece placement on the board.
- The system indexes exposed boundary tabs and holes on the active assembly frontier, narrowing future candidate slots for neighboring pieces.

#### 2.3 UI & Canvas Standards
- **Pan vs. Click Isolation**: $>3\text{ px}$ drag threshold prevents accidental piece placements during board panning.
- **Contour-Masked Artwork**: Pieces render with clean transparent backgrounds outside the contour, oriented upright in cardinal directions.
- **Zero Seam Debug Clutter**: Purge manual pair verification panels and broken pairwise seam diagnostic modals from the primary workflow.

---

### 3. Consequences

#### Positive
- **High Assembly Reliability**: Replaces fragile, error-accumulating 1D greedy chaining with robust multimodal poster correlation + topology pruning.
- **Fast Interactive Feedback**: Heatmaps compute in <3ms resident in WASM memory, giving instant guidance on arbitrary piece draws.
- **Natural Human-Machine Collaboration**: Leverages human spatial pattern recognition for the initial frame while computer vision does the heavy lifting of indexing, searching, and visual matching across 1,008 slots.

#### Trade-offs
- Requires the user to assemble the border manually before interior heatmaps reach maximum pruning efficiency (though coarse regional heatmaps work even without the border).
