# Jigsaw Puzzle Assembly Strategy & Architecture

This document defines the physical interaction model, mathematical foundations, and vision algorithms for assembling a 1,000-piece physical puzzle using a hybrid approach: **Multimodal Global Border Optimization** followed by **Inward Boundary Propagation & Spatial Probability Density Heatmaps**.

---

## 1. Physical Reality & Core Operating Constraints

Physical jigsaw puzzle assembly via a standard camera and WebAssembly operates under strict physical and optical constraints:

1. **Zero Physical Labeling**: Pieces are pulled at random from a mixed cardboard box. The user never labels, numbers, or pre-sorts pieces. The system must accept any arbitrary piece and direct the user where it belongs.
2. **Die Repeatability (Identical Twins)**: Commercial manufacturers stamp 1,000-piece puzzles using a 250-piece die repeated 4 times or flipped 180°. Pure contour geometry cannot distinguish between identical die twins on opposite sides of the puzzle.
3. **Cardboard Kerf & Shadow Noise**: Die-cut edges produce 1–3 pixel shadow variations under ambient lighting. Contour $L_2$ curves alone are susceptible to greedy error accumulation.
4. **The Single-Piece Poster Trap**: An isolated interior piece with low spatial entropy (e.g., solid sky, dark foliage) produces dozens of false-positive correlation peaks across the reference poster. Single-piece poster matching must be treated as a **spatial probability distribution**, not an absolute coordinate.
5. **Universal Solver Generalization (1,008-Piece Scope)**: The ultimate goal is solving the complete 1,008-piece puzzle, not just the perimeter. The 124 border pieces serve as the initial validation set and rigid frame anchor, but the underlying 7-step mating pipeline (topology $\to$ metric tolerances $\to$ seam ink MGC $\to$ sub-pixel contour analysis $\to$ best-buddies $\to$ cluster formation $\to$ poster alignment) must be universal. Algorithms and data structures must never be siloed as border-only one-offs.

---

## 2. Two-Stage Solving Architecture

The solver divides the assembly into two distinct phases:

```
┌────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: MULTIMODAL GLOBAL BORDER OPTIMIZATION (Offline, Closed Set)   │
│ • All 124 border pieces scanned upfront.                               │
│ • Metric dimensions (mm) + Tab/Hole polarity + Seam Ink Continuity.    │
│ • Mutual Best-Buddies clustering.                                      │
│ • Global loop closure enforcing exact side counts (34 × 26 × 34 × 26). │
│ • Frame-to-Poster rigid alignment locks all 124 pieces.                │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: INWARD BOUNDARY STREAMING & HEATMAPS (Online, Random Draw)    │
│ • User draws any random piece from the box and stages it.              │
│ • Priority 1 (Boundary Extension): Check against 120 exposed seams.    │
│ • Priority 2 (Pocket Filling): Check 2-edge and 3-edge pockets.        │
│ • Priority 3 (Island Heatmap): If unanchored, compute 28×36            │
│   Probability Density Heatmap P(R, C | I) across the grid.             │
│ • Cluster Collapse: Snapping 2–3 island pieces multiplies entropy,     │
│   collapsing diffuse heatmaps into pinpoint coordinates.               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Stage 1: Multimodal Border Solver

### 3.1 The Constraint Hierarchy

Instead of open-ended greedy chaining, the border solver filters candidate pairs through a cascading 7-step constraint hierarchy:

1. **Step 1: Edge Topology Filtering**:
   - Enforce discrete edge polarity (Tab requires a Hole; Flat outer edges never search for mating pairs).
   - Fast, cheap $O(1)$ binary check (either has it or doesn't).
   - Border pieces have exactly 1 flat edge; corners have exactly 2 perpendicular flat edges locked to the outer perimeter.
2. **Step 2: Metric Dimension Tolerances**:
   - Using the 100mm calibration mat scale ($96\text{ px} = 25.0\text{ mm}$), seam lengths, tab widths, and tab depths must match within calibrated physical tolerances ($\pm 0.3\text{ mm}$). Pairs with dimensional mismatches are rejected in $O(1)$ time.
3. **Step 3: Seam Ink Continuity (Modified Gradient Compatibility - MGC)**:
   - For candidate pieces $u$ and $v$, sample RGB pixel values 2–3 pixels inward from the cut line.
   - Extrapolate the color and gradient vector across the seam:
     $$\text{Cost}_{\text{MGC}}(u, v) = \sum_{k} \| \nabla I_u(k) - \nabla I_v(k) \|^2$$
   - Eliminates die-cut twins from other quadrants: a blue tab will never mate with a green hole, even if cut from the identical die.
4. **Step 4: Sub-pixel Interlocking Contour Analysis**:
   - Compare complementary tongue-and-groove contour curves within tolerance (normalized profile, neck width, ear roundness, and entry angle) as the decisive physical check before clustering.
   - Discard false pairings where ink and baseline match but physical contours collide or fail mechanical fit.
5. **Step 5: Mutual Best-Buddies Filtering**:
   - Piece $A$'s edge and Piece $B$'s edge are locked into a micro-cluster if and only if both rank each other as #1 across combined metric, ink, and contour criteria:
     $$\text{Rank}(A \to B) = 1 \quad \text{AND} \quad \text{Rank}(B \to A) = 1$$
6. **Step 6: Micro-Clusters & Global $34 \times 26$ Loop Optimization**:
   - Assembles rigid 2-piece and 3-piece micro-clusters into a closed ring satisfying exact side counts (Top: 34, Right: 26, Bottom: 34, Left: 26 non-corner pieces).
7. **Step 7: Frame-to-Poster Rigid Alignment**:
   - Anchors the assembled 124-piece rectangular frame to the master reference poster with zero coordinate ambiguity.

### 3.2 Global Constrained Loop Optimization

With Best-Buddies segments formed:
- The solver finds the cyclic permutation of segments that minimizes total seam residual while strictly satisfying:
  - Top edge: exactly 34 non-corner pieces.
  - Right edge: exactly 26 non-corner pieces.
  - Bottom edge: exactly 34 non-corner pieces.
  - Left edge: exactly 26 non-corner pieces.
  - Closed-loop boundary condition: Seam error from the final piece back to Corner 1 is minimized.

### 3.3 Frame-to-Poster Rigid Alignment

Once the 124-piece border is assembled into a single rigid rectangular frame:
- The entire frame is matched against the reference poster.
- Because a 124-piece rectangular frame spans massive spatial area, color and feature alignment is mathematically deterministic and immune to local sky/texture ambiguities.
- All 124 border pieces receive their exact $[Row, Col]$ grid coordinates and cardinal rotations.

---

## 4. Stage 2: Inward Boundary Streaming & Heatmaps

For the remaining 884 interior pieces, scanning everything upfront is unnecessary. The user draws pieces one by one from the box:

### 4.1 Inward Boundary Propagation & Pocket Filling
- The placed border pieces expose inward-facing edges to the grid.
- When an interior piece is placed on the camera mat:
  - Its 4 edges are compared against all currently exposed boundary seams on the board.
  - **1-Edge Boundary Match**: Evaluates Tab/Hole polarity, metric millimeter width ($\pm 0.3\text{ mm}$), Seam MGC color continuity, and **sub-pixel interlocking contour curve fit**. If all physical criteria pass, the piece locks adjacent to its placed neighbor.
  - **2-Edge & 3-Edge Pockets**: Corner pockets (e.g. `[1, 1]`) require simultaneous multi-seam compatibility (metric, ink, and contour curve interlocking) with both North and West neighbors. This dual constraint provides a 100% unique mathematical lock.

### 4.2 Spatial Probability Density Heatmaps $P(R, C \mid I)$
If a piece does not connect to the current active boundary:
- The engine does not guess a single coordinate. It computes the normalized similarity across all $28 \times 36$ poster slots for the 4 cardinal rotations.
- This produces a 2D probability density function:
  $$P(R, C \mid I) \propto \exp\left(\frac{S(R, C) - \max(S)}{\tau}\right)$$
- **High-Entropy Pieces** (faces, text, high-contrast objects): Produce a sharp peak ($>90\%$). The board highlights the exact landmark slot as an island anchor.
- **Low-Entropy Pieces** (sky, water, solid colors): Produce a diffuse regional heat glow across candidate rows/columns (e.g., *Upper Sky: Rows 1–5, Cols 10–24*). The user places the piece in that general zone on their physical table or sets it aside in the tray.

### 4.3 Island Clusters & Entropy Multiplication
- When two or more pieces placed in an island zone snap together on the table, their combined area doubles.
- The engine matches the **connected multi-piece cluster** against the poster.
- Combined spatial entropy collapses the diffuse regional heatmap into a single, sharp, unambiguous $[Row, Col]$ coordinate.

---

## 5. Visual Standards for the Assembly Board

To ensure the board view is a clean, practical assembly tool:
1. **Contour-Masked Piece Artwork**:
   - The board never displays raw camera thumbnails with white paper backgrounds, green OpenCV lines, or corner markers.
   - Pixels outside the piece contour are masked transparent.
   - The piece is rendered upright, aligned strictly with the cell's cardinal orientation, filling the cell cleanly without aspect ratio distortion.
2. **Pan / Zoom Isolation**:
   - Mouse movement during a drag/pan must never trigger piece placement. A threshold of $>3\text{ px}$ drag distance distinguishes panning from clicking.
3. **Clean HUD Overlays**:
   - Active placement indicators render as a single distinct highlight on the target cell.
   - Regional candidate zones render as a soft, translucent heat glow over the grid cells.
4. **Streamlined Calibration**:
   - Lens K1 distortion tuning lives exclusively inside the full-screen camera calibration view alongside fiducial corner adjustments.
   - The main assembly workbench remains free of optical sliders and debug controls.
