# ADR 001: Architecture Status and Vision Roadmap for Physical Jigsaw Puzzle Solver

Status: Accepted
Date: 2026-09-23

## Context

Solving physical jigsaw puzzles with a computer camera requires combining two distinct worlds:
1. Physical Computer Vision: Taking a photo of a real cardboard piece under uneven room light, with phone or webcam lens distortion, shadows, and glares.
2. Computational Matching: Finding exactly where that piece belongs on a high-resolution digital master image (like Starry Night) and how it fits with neighboring pieces.

We need an Architectural Decision Record (ADR) that clearly documents:
- What we have built so far and how it currently works.
- The gaps when compared to computer vision literature and open-source projects.
- The concrete roadmap to evolve the system into a robust, laboratory-grade physical puzzle assistant.

---

## Part 1: Current Architecture & Capabilities (What We Have)

The project consists of a high-performance Go backend and an interactive web studio.

### 1. Ingestion and Segmentation
- Camera Input: WebRTC live video feed or uploaded still photos.
- Contrast & Background: Supports both light backgrounds (white paper/poster board) and dark puzzle boards.
- Adaptive Binarization: Implements Otsu automated thresholding, computing the bimodal histogram cutoff to separate the cardboard piece from the background surface.
- Connected-Component Noise Filtering: Eliminates tiny dust particles, table scratches, and background shadows by keeping only the dominant connected component above a configurable minimum area.
- Boundary Extraction: Extracts the 2D perimeter of the piece and resamples it into a normalized 160-point smoothed contour for geometric calculations.

### 2. Physical Edge and Corner Detection
- 90-Degree Orthogonal Corner Finding: Identifies the 4 primary piece corners using curvature extrema, convex hull points, and angle dot products targeting roughly 90 degrees.
- Edge Segmentation: Slices the continuous contour into 4 distinct physical edges: Top, Right, Bottom, Left.
- Topology Classification: Measures the chord line connecting corner to corner, tracking the maximum outward protrusion and inward indentation. Classifies each edge into:
  - Tab: Convex bump sticking outward.
  - Blank: Concave hole going inward.
  - Flat: Straight edge (indicates a puzzle border piece).
- Human-in-the-Loop (HITL) Assist: A web interface allowing the user to override edge classifications if room glare tricked the vision model, followed by instant candidate re-ranking.

### 3. Master Reference Indexing & Candidate Placement
- Reference Pre-computation: Divides the master artwork (e.g. 1000 pieces, 25 rows by 40 columns) into discrete grid tiles.
- Multi-Rotation Descriptors: Precomputes color and gradient descriptors for every grid tile across 4 discrete rotations (0 deg, 90 deg, 180 deg, 270 deg).
- Feature Descriptors:
  - CIE-Lab Chromaticity: Mean a and b channels, plus standard deviation, to be less sensitive to overall light intensity.
  - 16-Bin Hue Histogram: Measures color family distribution independent of lighting brightness.
  - 8-Bin HOG (Histogram of Oriented Gradients): Captures local edges and brushstroke directions.
- Scoring & Detailed Feedback: Ranks the top candidates using topology constraints (e.g. border pieces are only tested against border slots) and displays a percentage breakdown of why it matched (Hue match %, Chroma match %, Texture HOG match %).

### 4. Interactive Studio UI
- Sections ordered by priority: Section 3 (Master Placement), Section 1 (Ingestion & HITL), Section 2 (Computer Vision Multi-Layer View).
- Ravensburger-inspired design palette and clean typography with zero emoji icons.
- Visual diagnostics: RGB channel distributions, HOG bar charts, corner angles, and exposure warning meters for specular glare.

---

## Part 2: Gaps and Key Missing Pieces (Compared with Literature)

Academic literature (such as Gallagher 2012, Pomeranz et al. 2011, and Paikin & Tal 2015) and industrial vision systems highlight several missing components in our current implementation.

### 1. Camera Angle & Scale Calibration (Keystone Distortion)
- The Problem: When a user holds a camera or angles a webcam, the camera is rarely tilted at an exact 90-degree bird's-eye angle. A tilt of even 5 degrees causes perspective distortion (keystone effect), making straight edges look curved and distorting piece dimensions.
- The Gap: We currently assume the piece is photographed from directly above without perspective warp, and we do not know the exact physical size (millimeters per pixel).
- Solution from Literature:
  - Use 4 ArUco markers or a printed reference border on the scanning mat.
  - Compute a 3x3 Homography transformation matrix to warp the image into a true top-down perspective.
  - Use known physical marker dimensions to calculate the exact scale ratio (e.g. 12.5 pixels per millimeter).
- References:
  - Zhang, Z. (2000). "A flexible new technique for camera calibration." IEEE Transactions on Pattern Analysis and Machine Intelligence (PAMI).
  - OpenCV Camera Calibration and Homography Documentation.

### 2. Continuous Curve Matching (Shape Interlocking)
- The Problem: Our system currently labels an edge simply as Tab, Blank, or Flat. However, puzzle manufacturers (like Ravensburger) cut pieces with unique continuous curves so that only the matching neighbor physically interlocks.
- The Gap: We do not compare the exact mathematical curve of a tab against the curve of an adjacent piece.
- Solution from Literature:
  - Turning Function Representation: Express each edge contour as a function of tangent angle versus normalized arc-length.
  - Dynamic Time Warping (DTW) or Modified Hausdorff Distance: Measure the curve distance between an outward tab curve and an inverted inward blank curve.
- References:
  - Arkin, E. M., Chew, L. P., Huttenlocher, D. P., Kedem, K., & Mitchell, J. S. (1991). "An efficiently computable metric for comparing polygonal shapes." IEEE PAMI.
  - Wolfson, H. (1990). "On curve matching." IEEE PAMI.

### 3. Sub-Pixel Continuous Registration (ORB / SIFT Feature Matching)
- The Problem: We currently test pieces against fixed, discrete square grid boxes (Row R, Column C). In real puzzles, pieces can be slightly offset from a rigid grid, or the die-cutter pattern shifts slightly relative to the print.
- The Gap: If a piece sits across two virtual grid squares, rigid tile-histogram matching loses precision.
- Solution from Literature:
  - Extract scale-invariant keypoints (ORB or SIFT) directly from the piece artwork surface.
  - Match feature descriptors between the physical piece and the master reference image.
  - Use RANSAC (Random Sample Consensus) to estimate the exact continuous (x, y) coordinates and rotation angle (e.g. 17.3 degrees rather than only multiples of 90 degrees).
- References:
  - Lowe, D. G. (2004). "Distinctive image features from scale-invariant keypoints." International Journal of Computer Vision (IJCV).
  - Rublee, E., Rabaud, V., Konolige, K., & Bradski, G. (2011). "ORB: An efficient alternative to SIFT or SURF." IEEE International Conference on Computer Vision (ICCV).

### 4. Color Constancy & Glare Correction
- The Problem: Indoor domestic lighting varies from warm incandescent (2700K) to cool fluorescent (6500K). Cardboard puzzle pieces also have a glossy finish that creates white specular glare under direct light bulbs.
- The Gap: Glare destroys color information in saturated pixels, and warm room lighting shifts color values away from the clean digital reference image.
- Solution from Literature:
  - Grey-World / White-Patch Algorithm: Estimate the ambient light color and normalize the scanned image.
  - Calibration Target: Include a neutral grey/white reference patch on the scanning mat to calculate an illumination correction matrix.
  - Glare Inpainting: Detect pixels with luminance over 240 and inpaint them using surrounding color textures (Telea or Navier-Stokes inpainting).
- References:
  - Finlayson, G. D., & Trezzi, E. (2004). "Shades of gray and colour constancy." IS&T/SID Color Imaging Conference.
  - Telea, A. (2004). "An image inpainting technique based on the fast marching method." Journal of Graphics Tools.

### 5. Global Assembly State & Adjacency Constraints
- The Problem: Currently, every piece is scanned in isolation. The system does not remember previously scanned pieces.
- The Gap: As you place pieces on the table, every placed piece creates strict physical boundaries for empty neighboring slots.
- Solution from Literature:
  - Assembly Graph / Minimum Spanning Tree (MST): Maintain a persistent board state.
  - When Piece A is placed at (Row 4, Col 8) with a Tab on its Right edge, the vacant slot at (Row 4, Col 9) is immediately updated to require a Blank on its Left edge.
  - This eliminates false candidate matches and accelerates placement as more pieces are assembled.
- References:
  - Gallagher, A. C. (2012). "Jigsaw puzzles with pieces of unknown orientation." IEEE CVPR.
  - Pomeranz, D., Shemesh, M., & Ben-Shahar, O. (2011). "A fully automated greedy square jigsaw puzzle solver." IEEE CVPR.
  - Paikin, G., & Tal, A. (2015). "Solving jigsaw puzzles with missing pieces." IEEE CVPR.

---

## Part 3: Phased Implementation Plan

Based on these findings, future engineering work is prioritized as follows:

### Phase 1: Camera Mat with 4-Point Homography & Scale (Perspective Fix)
- Create a printable scanning mat with 4 corner reference markers and a known physical scale.
- Implement perspective unwarping so every scanned piece is viewed directly from above, regardless of camera tilt.
- Benefit: Immediate improvement in corner and edge accuracy under real phone and webcam conditions.

### Phase 2: Assembly Board State Tracking
- Add a session storage mechanism in the web app and Go server to track "Placed Pieces".
- Dynamically eliminate already placed slots from candidate searches.
- Propagate edge constraints to adjacent empty board locations.
- Benefit: Greatly reduces candidate search space and prevents duplicate placements.

### Phase 3: Continuous Curve Matching (Turning Function / DTW)
- Store normalized edge curves for every scanned piece.
- Check interlocking tolerance between candidate neighbors before confirming placement.
- Benefit: Resolves visual ambiguity in uniform artwork areas (like sky or ocean) using pure physical geometry.

### Phase 4: Local Feature Matching (ORB + RANSAC)
- Implement ORB feature point detection on the piece and artwork.
- Compute continuous translation and rotation for fine alignment.
- Benefit: Delivers sub-pixel placement accuracy and supports arbitrary continuous piece rotations.

---

## Consequences

- Positive:
  - Provides a clear technical roadmap aligned with established computer vision literature.
  - Separates immediate physical camera issues (perspective, glare) from long-term combinatorial solver challenges.
  - Enables incremental improvements without breaking the existing Go server or web studio.
- Trade-offs:
  - Requiring a printable scanning mat (Phase 1) introduces a minor physical setup step for the user, but eliminates severe optical distortions that software alone cannot reliably guess.
