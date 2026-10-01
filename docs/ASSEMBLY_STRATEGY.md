# Jigsaw Puzzle Assembly Strategy & Architecture

This document defines the physical interaction model, solving strategy, and vision algorithms for assembling the physical jigsaw puzzle using a hybrid approach (**Mode A: Scan As You Pick** + **Mode C: Targeted Hole-Filling**) alongside **Illumination-Invariant Poster Reference Matching**.

---

## 1. Tabletop Workflow Overview

Solving a 500- to 2,000-piece puzzle by scanning all pieces upfront in one giant batch is exhausting and requires excessive sorting trays. Instead, the solver employs a **reactive, dual-mode tabletop workflow**:

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 USER'S TABLETOP WORKFLOW               │
                  └────────────────────────────────────────────────────────┘
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      ▼                                               ▼
        [ MODE A: SCAN AS YOU PICK ]                    [ MODE C: HOLE TARGETING ]
    • Grab piece from box / loose pile              • Look at an interesting hole/slot
    • Drop into 65mm arena (1 second)               • Tap empty slot on Virtual Board
    • Audio "Beep" locks contour + crop             • App shows exact missing piece preview:
    • Engine checks:                                  - "Piece #37 (Red corner of house)"
      1. Is it a border/corner piece?               • Highlights slot outline & color cue
         -> Snap directly to frame position!        • If piece was already scanned:
      2. Does it snap to an existing piece?           -> "In your tray: Piece #48!"
         -> "Place at Row 8, Col 14"                • If not yet scanned:
      3. No active neighbor slot yet?                 -> "Looking for: Male Tab North,
         -> Stored in "Scanned Tray / Inventory"         Female Hole West, Forest Green"
```

---

## 2. Interaction Modes in Detail

### Mode A: "Scan As You Pick" (Continuous Ingestion & Instant Placement)
1. **Quick Drop**: The user grabs any loose piece from the box and places it inside the calibration mat's $65 \times 65\text{ mm}$ arena.
2. **Sub-50ms Lock**: Real-time auto-capture detects stability, locks corners, generates the 4 edge signatures, and extracts an affine-rectified texture crop.
3. **Instant Decision Routing**:
   - **Route 1: Corner / Border**: If 1 or 2 edges are `Flat`, the piece is immediately placed on the perimeter frame or assigned a bounded set of candidate border slots.
   - **Route 2: Active Slot Snap**: If the piece's curves and artwork match an open boundary slot on the assembly board, an audible chime plays and the screen highlights the physical slot (e.g., *"Place at Row 14, Col 6 — Snaps to East of Piece #21"*).
   - **Route 3: Tray Buffer**: If the piece belongs to an interior region not yet connected to the main assembly, it is registered in the **Piece Tray (Scanned Inventory)** with its estimated $(x, y, \theta)$ poster coordinate.

### Mode C: "Targeted Hole-Filling" ("What goes here?")
1. **Slot Selection**: As the puzzle boundary expands on the table, the user identifies an empty slot or key gap (e.g., trying to finish a face, a building roof, or a 3-sided pocket).
2. **Tap-to-Target**: The user clicks the empty slot on the interactive **Virtual Board UI**.
3. **Constraint Synthesis**: The engine evaluates all adjacent placed neighbors to generate the exact missing physical specification:
   - Example: `North = Female (matches Edge #14)`, `West = Male (matches Edge #88)`, `South = Flat`, `Artwork = [sky-blue gradient]`.
4. **Instant Resolution**:
   - **Case 1: Already Scanned**: If the matching piece exists in the Scanned Tray, the app flags it with a bright badge and shows its thumbnail and required orientation.
   - **Case 2: Unscanned**: If the piece is still in the box, the app renders a **Phantom Template** (exact tab shapes + expected artwork crop from the poster), allowing the user to scan their eyes across the physical pieces in the box and spot it quickly.

---

## 3. Illumination-Invariant Reference Poster Matching

### The Real-World Lighting & Print Problem
Direct RGB pixel matching between cardboard pieces and box cover images fails in practice due to:
- **Finish Differences**: Cardboard pieces are matte textured; box covers are glossy/varnished.
- **Lighting Variability**: Ambient room light (warm white vs cool daylight vs shadows) creates severe color cast.
- **Dynamic Range**: Direct lighting creates specular glare spots on the puzzle pieces.

### The 3-Tier Invariant Solution

```
    [ Scanned Piece Crop ]                      [ Box Cover Poster ]
              │                                          │
              ▼                                          ▼
   [ 1. Color Normalization ]                 [ 1. Color Normalization ]
   • Convert RGB -> CIELAB                    • Global LAB color space
   • Equalize Lightness (CLAHE)               • Illuminant white-balance
              │                                          │
              ▼                                          ▼
   [ 2. Structural Features ]                 [ 2. Structural Features ]
   • Gradient Orientations (Sobel / HOG)      • Spatial Multi-Scale Gradient Map
   • Keypoint descriptors (ORB / FAST)        • FAST Keypoint Pyramid
              │                                          │
              └───────────────────┬──────────────────────┘
                                  ▼
                    [ 3. Dual-Lock Verification ]
                 • Coarse $(x, y, \theta)$ via Vision
                 • Fine Verification via Boundary Curves
```

1. **Illumination-Invariant Representations**:
   - **CIELAB Color Space**: Separates lightness ($L^*$) from chromaticity ($a^*, b^*$), eliminating pure brightness variations.
   - **Contrast-Limited Adaptive Histogram Equalization (CLAHE)**: Normalizes local contrast before feature extraction.
   - **Gradient & Edge Orientations (HOG / Sobel)**: Emphasizes artwork outlines and texture transitions instead of absolute color values.
   - **ORB Keypoint Descriptors**: Rotation- and scale-invariant binary descriptors robust to affine distortions.

2. **Dual-Lock Constraint System**:
   - **Vision (Poster)** provides coarse spatial localization: narrows down the candidate location on the board to a small region or specific cluster.
   - **Geometry (Curve Mating)** provides the physical mathematical lock: tab-and-blank $L_2$ turn-angle error must be below tolerance for pieces to snap together.

---

## 4. Architectural State & Data Structures

### Scanned Piece Record (`Piece`)
```rust
pub struct Piece {
    pub id: u32,
    pub timestamp: f64,
    pub status: PieceStatus, // InTray, Placed(r, c), Rejected
    pub corners: [(f32, f32); 4],
    pub edges: [Edge; 4],
    pub metric_dimensions_mm: (f32, f32),
    pub poster_estimate: Option<PosterPlacement>,
    pub texture_crop_id: String,
}

pub struct Edge {
    pub edge_type: EdgeType, // Flat, Tab, Hole
    pub normalized_turn_angles: Vec<f32>, // 100 arc-length equidistant samples
    pub chord_length_px: f32,
}

pub struct PosterPlacement {
    pub x_px: f32,
    pub y_px: f32,
    pub rotation_deg: f32,
    pub confidence: f32,
}
```

### Board Grid Graph (`AssemblyBoard`)
```rust
pub struct AssemblyBoard {
    pub rows: usize,
    pub cols: usize,
    pub grid: Vec<Vec<Option<u32>>>, // Stores Piece IDs at (r, c)
    pub open_boundary_slots: Vec<SlotConstraint>,
}

pub struct SlotConstraint {
    pub row: usize,
    pub col: usize,
    pub required_north: Option<EdgeConstraint>,
    pub required_east: Option<EdgeConstraint>,
    pub required_south: Option<EdgeConstraint>,
    pub required_west: Option<EdgeConstraint>,
}
```

---

## 5. Literature-Grounded Architecture & Implementation Plan

The architecture incorporates the 4 core literature recommendations:
1. **Lighting & Finish Invariance (Literature Principle 1)**:
   - CIELAB color separation ($L^*$ vs $a^*, b^*$).
   - Tile-based CLAHE contrast equalization to eliminate specular glare from glossy box covers.
   - 8-bin quantized Sobel orientation maps matching structural edge transitions instead of raw RGB.
2. **Dual-Lock Hierarchy (Literature Principle 2)**:
   - *Vision / Poster Matching*: Fast $O(1)$ candidate location proposal $(\text{col}, \text{row}, \theta)$.
   - *Geometry / Curve Mating*: Strict mathematical $L_2$ turn-angle physical lock between complementary tabs and holes.
3. **Die-Cut Tolerance & Grid Drift (Literature Principle 3)**:
   - Nominal poster grid cells serve as elastic spatial priors rather than rigid coordinate boxes.
   - Placed pieces and perimeter frame anchor the local coordinate mesh to compensate for physical die-cut curvature.
4. **Human-in-the-Loop Reactive Assist (Literature Principle 4)**:
   - **Mode A: Scan As You Pick**: Sub-50ms piece classification and immediate border/snap routing.
   - **Mode C: Targeted Hole-Filling**: Tapping an empty slot on the board previews the exact missing piece artwork (`get_slot_preview`) and filters the tray for matching edge geometry.

---

## 6. Implementation Milestones

### Phase 7: Step 2 — Piece Inventory Management & Interactive Assembly Board (`BoardView.tsx`)
- **7.1 Persistent Piece Tray (IndexedDB / LocalStorage)**: Store scanned pieces with thumbnails, edge profiles, and metric dimensions ($W \times H\text{ mm}$).
- **7.2 Interactive Board Canvas with Mode C Hole Targeting**: Tap any empty board slot to render target slot artwork (`get_slot_preview`), nominal dimensions, and filter inventory for compatible tab/hole configurations.
- **7.3 Manual Placement & Pair Verification Harness**: Drag-and-drop pieces from tray onto board slots; export verified mated pairs as JSON ground-truth fixtures.

### Phase 8: Step 3 — Edge Curve Signatures & Pairwise Mating Engine (`cv-engine/src/matcher.rs`)
- **8.1 Arc-Length Equidistant Resampling**: Resample each of the 4 edges into $N = 100$ equidistant points along the contour.
- **8.2 Intrinsic Turn-Angle Profiles**: Compute chord-relative turn-angle signature $\theta(s)$ or curvature $\kappa(s)$.
- **8.3 Pairwise $L_2$ Compatibility Scoring**: Fast filter (opposite edge types: Tab $\leftrightarrow$ Hole, Flat $\leftrightarrow$ Flat) followed by sliding-window Euclidean difference $L_2(\theta_A, -\theta_B)$.
- **8.4 Mating Test Suite**: Rust unit tests against verified physical pairs exported in Step 2.

### Phase 9: Step 4 — Hybrid Dual-Lock Solver, AR Guidance & PWA
- **9.1 Multi-Scale Feature Hashing**: FAST / ORB keypoint matching against the precomputed poster pyramids.
- **9.2 Dual-Lock Solver Engine**: Combine Visual Landmark Score + Geometric Boundary Score with $O(1)$ slot elimination.
- **9.3 Augmented Reality Guidance**: In-situ camera overlay indicating table snap position for the scanned piece.
- **9.4 Offline PWA Support**: Full offline capability with service worker caching and session progress recovery.

