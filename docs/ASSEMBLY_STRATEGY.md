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

## 5. Implementation Roadmap Integration (Phase 6–8)

1. **Milestone 6.1**: Normalized equidistant arc-length edge sampling & turn-angle signature extraction (`cv-engine/src/matcher.rs`).
2. **Milestone 6.2**: Pairwise $L_2$ edge compatibility scoring (tab-hole complementarity).
3. **Milestone 6.3**: Perimeter border loop solver (4 corners + border pieces forming a closed rectangular constraint).
4. **Milestone 6.4**: Interactive Virtual Board UI (`web-app/src/components/BoardView.tsx`) with Scanned Tray and empty slot selection.
5. **Milestone 7.1**: Poster image ingestion, multi-scale gradient pyramid, and CLAHE normalization.
6. **Milestone 7.2**: Dual-constraint solver combining poster visual coordinates with geometric boundary verification.
