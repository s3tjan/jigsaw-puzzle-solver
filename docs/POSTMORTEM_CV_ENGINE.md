# CV & Vision Engine Postmortem: Analysis of Historical Bugs, Regressions, and Stabilizations

**Project:** Jigsaw Puzzle Solver (Rust + WebAssembly + React)  
**Document Status:** Living Postmortem & Incident Log  
**Scope:** Computer Vision Pipeline, Camera Calibration, Contour Extraction, Corner Detection, Edge Classification, and Ground-Truth Benchmarking.

---

## Executive Summary

Building a browser-based, zero-cloud real-time physical jigsaw puzzle solver requires sub-millimeter precision under unconstrained optical conditions (lighting fluctuations, hand shadows, lens distortion, macro webcam wobble, sensor shot noise).

During development of the CV pipeline, several categories of critical bugs and regressions emerged:
1. **Corner Misidentification & Quad Collapse**: Identifying inner tab fillets or outer tab crowns instead of true mechanical corners.
2. **Perception Wobble & Frame-to-Frame Jitter**: Subtle optical sensor noise causing corners to jump and edge types (Tab vs. Hole) to flip-flop dynamically.
3. **Scale & Distance Fragility**: Algorithms tuned for fixed camera distances failing when the user moves or zooms the camera (macro vs wide FOV).
4. **Calibration Mat Bleed**: High-contrast fiducial marks bleeding into the piece segmentation arena.
5. **Ground Truth Tooling Divergence**: Inability to isolate algorithmic bugs because benchmark datasets lacked distinct ground truth vs. detected corner tracking and allowed mislabeled edges.

This postmortem categorizes every identified bug, details the root causes, describes the implemented resolutions, and establishes architectural guardrails to prevent regressions.

---

## 1. Corner Detection & Geometry Optimization Bugs

### Bug 1.1: Single Extremum Collapse (Tab/Hole Crown Misidentified as Corner)
* **Symptoms:** Corners $C_1 \dots C_4$ would snap to the tip of an outward Tab or into the apex of an inward Hole rather than the mechanical boundary intersection.
* **Root Cause:** Early corner detection relied purely on maximum Euclidean distance from the piece centroid $d_i = \sqrt{(x_i - c_x)^2 + (y_i - c_y)^2}$ or simple Harris/Shi-Tomasi corners. Because tabs protrude furthest from the center, the tab crowns scored higher than true corners.
* **Resolution:**
  - Shifted to a composite scoring function combining:
    1. Distance from centroid normalized by piece radius ($r_{\text{est}}$).
    2. Local boundary curvature angle (cosine of angle between vectors spanning $k$-steps along the contour: $k \approx n / 36$).
    3. Convexity check using the 2D cross product $v_1 \times v_2$.
    4. Orthogonal quadrant assignment ($45^\circ, 135^\circ, 225^\circ, 315^\circ$ partitions relative to piece major axes).
  - Implemented multi-candidate combinatoric search: collect top 4 candidates per quadrant and select the 4-corner combination that minimizes opposite-edge length differences and parallelogram diagonal midpoint divergence.

### Bug 1.2: Scale & Resolution Variance Breakdown
* **Symptoms:** Piece detection worked flawlessly at ~350px width, but failed (0 corners or collapsed edges) at 180px or 600px macro zoom.
* **Root Cause:** Hardcoded pixel constants ($k = 8\text{ px}$, curvature thresholds $\text{chord} > 42.0\text{ px}$, distance gating $\text{dist} < 15\text{ px}$) were unnormalized. When the camera FOV changed or the user brought the lens closer, boundary sample counts $n$ varied from 250 to 900 points.
* **Resolution:**
  - Scaled all kernel spans proportionally to contour circumference $n$:
    $$k_{\text{span}} = \text{clamp}\left(\frac{n}{36}, 8, 16\right)$$
  - Normalized distance metrics using estimated radius $r_{\text{est}} = \frac{1}{n} \sum \|p_i - C\|$.

### Bug 1.4: Tab-Neck Fillet Parallelogram Collapse & Border Flat Classification
* **Symptoms:** In 4-tab pieces or rotated border pieces, corners erroneously snapped to inward tab neck fillets (~50px error), and flat border cuts were misclassified as tabs/holes.
* **Root Cause:**
  1. *Topological Concealment:* Inner tab neck fillets make sharp $90^\circ$ turns, scoring high in corner sharpness $(1 - \text{dot})$, and opposing neck pairs created an artificially balanced parallelogram with near-zero diagonal error.
  2. *Single-Pass Flat Cut Fragility:* Flat edge identification previously depended on a fragile, single-threshold straight line pre-pass ($\text{std\_res} < 0.45\text{px}$). Perspective tilt pushed residuals to $0.61\text{px}$, causing true border edges to fall through to `Interior`.
* **Resolution:**
  - *Topological Convexity Gating:* Enforced 2D cross product gating ($\text{cross} < -0.05$) to strictly reject re-entrant / concave vertices from corner candidate pools (`q_cands`).
  - *Physical Tab-Cut Zero Crossing:* Lowered chord zero-crossing detection threshold to $5.0\text{px}$, penalizing any candidate chord slicing across tab shoulders.
  - *Relative Edge Bimodality Classification:* Classified edges by relative depth separation (border pieces exhibit an order-of-magnitude difference: $\frac{\text{depth}_{\text{tab}}}{\text{depth}_{\text{flat}}} > 8$, $s_3 - s_0 \ge 2.0$) rather than relying on brittle boolean flags.

---

## 2. Wobble, Sensor Jitter & Tab/Hole Edge Classification Flip

### Bug 2.1: Fillet-Bleed Edge Inversion (Tab $\leftrightarrow$ Hole Flipping)
* **Symptoms:** The piece is physically motionless on a tripod under uniform lighting, yet the live UI flickers between `Tab` and `Hole` on an edge between a tab and a hole.
* **Root Cause:**
  1. The corner index lands on the die-cut fillet curve (~5–8px transition zone).
  2. One frame's corner index jitters by 1 discrete contour sample into the tab shoulder; the next frame jitters 1 sample into the hole shoulder.
  3. Edge classification checked peak deviation across the *entire* edge arc from $0\%$ to $100\%$. The opposite feature's fillet bleed produced a false extremum with inverted sign.
* **Resolution:**
  - **Edge-Trimming / Guard Bands:** Exclude the boundary $10\%$ fillet transition zones near corner vertices when measuring peak curvature depth.
  - **Central Arc Integration:** Rather than relying on a single maximum extremum sample, evaluate the median/mean signed distance across the central $60\%$ of the edge segment:
    $$\text{sign} = \text{sign}\left(\sum_{s \in [0.20, 0.80]} \text{signed\_dist}(s, \text{chord})\right)$$
  - This guarantees that outward tabs and inward holes are classified by their dominant central body, rendering them immune to fillet jitter.

### Bug 2.2: Camera Sensor Shot Noise Wobble in Stationary Pieces
* **Symptoms:** Corners and baseline chords drifted by 1–3 pixels continuously while resting on the mat, causing the UI wireframes to vibrate visually.
* **Root Cause:** CMOS sensor thermal noise and slight rolling shutter exposure variations shifted binarization boundaries by $\pm 1$ pixel from frame to frame.
* **Resolution:**
  - **Dual-Stage Temporal Filter:**
    1. **Median Filter:** Compute running median coordinates of corners across recent frames.
    2. **Velocity-Gated Deadband:** If piece centroid displacement $< 2.5\text{ px}$, clamp small corner motions ($< 3.0\text{ px}$) using high-damping exponential moving average ($\alpha = 0.18$ live, $0.82$ history).
    3. Once physical movement exceeds $2.5\text{ px}$, immediately release the deadband to maintain zero-lag responsiveness.

### Bug 2.3: Edge Chord Endpoint Divergence & Contour Staircase Noise
* **Symptoms:** Baseline chords connecting corners drifted or wobbled relative to the piece corners, and contours exhibited discrete pixel-step roughness on close inspection.
* **Root Cause:**
  1. Sub-pixel line-intersection refinement updated `piece.corners`, but `PieceEdge.start_corner` and `PieceEdge.end_corner` remained bound to the unrefined raw contour indices.
  2. Moore-Neighbor radial boundary tracing produces integer pixel steps, and single-pass 5-point smoothing left ~0.16px average 2nd-derivative roughness.
* **Resolution:**
  - Synchronized `PieceEdge` start/end corners and curve sample boundaries with the sub-pixel refined corners.
  - Upgraded contour smoothing to 3 iterative passes of a binomial Gaussian kernel (`[1, 4, 6, 4, 1] / 16`), bringing mean directional jerk below 0.09px.
  - Added deterministic regression harness `test_wobble_smoothness.rs`.

---

## 3. Calibration, Lighting & Segmentation Invariants

### Bug 3.1: Fiducial Target Bleed into Piece Arena
* **Symptoms:** Threshold binarization detected dark black fragments around the perimeter of the staging area, corrupting piece contours when placed near the stage edge.
* **Root Cause:** Early calibration mats had inward-facing crosshairs, solid black alignment bars, and ArUco markers within 5mm of the staging perimeter. Projective dewarping pulled those black pixels directly into the stage buffer.
* **Resolution:**
  - **Calibration Mat v5.0 (`generate_mat.py`):**
    - Redesigned target corners with zero-bleed outward L-crosshairs pointing away from the $65 \times 65\text{ mm}$ scan area.
    - Added $2\%$ inward crop inset during homography dewarping to isolate the clean white bond paper arena.
    - Switched staging background standard from colored paper/cutting mat to clean white paper ($80\text{ gsm}$).

### Bug 3.2: Uneven Radial Lighting & Vignetting False Positives
* **Symptoms:** Shadows cast by the webcam stand or room lighting created non-uniform background luminance, causing Global Otsu thresholding to classify stage corners as foreground puzzle fragments.
* **Root Cause:** Assuming constant background brightness across the entire $400 \times 400$ dewarped stage.
* **Resolution:**
  - **Peripheral Margin Sampling:** Sample $12\text{ px}$ perimeter strips along Top, Bottom, Left, and Right margins.
  - **85th Percentile Background Luminance:** Discard dark shadows and bright glints by selecting the 85th percentile luminance value as the reference background color $(R_{\text{bg}}, G_{\text{bg}}, B_{\text{bg}})$.
  - **Perceptual Color Distance:** Compute perceptual delta $D = \sqrt{0.299 \Delta R^2 + 0.587 \Delta G^2 + 0.114 \Delta B^2}$ followed by a $3 \times 3$ Gaussian blur and morphological closing.

---

## 4. Ground Truth Tooling & Validation Gaps

### Bug 4.1: Human Ground Truth vs. CV Detected Corner Conflation
* **Symptoms:** In the regression test harness (`test_ground_truth.rs`), test failures could not distinguish between a slight algorithm drift and an inaccurate manual human label.
* **Root Cause:** The workbench JSON fixture format only saved a single `corners` array. When a user manually adjusted a misidentified corner, the initial CV detection was completely overwritten and lost.
* **Resolution:**
  - Hardened fixture schema to persist both:
    1. `corners`: Human-verified / adjusted ground truth reference coordinates.
    2. `detected_corners`: Raw CV algorithm output at the instant of capture.
  - Benchmark reports now output `DetErr` (initial detection error relative to human label) to quantify detector quality independently.

### Bug 4.2: Edge Type Label Clutter & Ambiguity
* **Symptoms:** In the labeling workbench, edge type badges (`Tab`, `Hole`, `Flat`) were placed at the geometric midpoint of the chord, often directly overlapping tab bumps or hole notches and confusing the user.
* **Resolution:**
  - Anchored edge badges dynamically to the peak curvature point along each edge (furthest contour point from the baseline chord), clearly positioning the label directly on the feature itself.
  - Implemented quadratic Bézier smoothing for visual contour rendering on high-DPI displays.

---

## Summary Matrix of Critical Incidents

| Issue ID | Component | Root Cause | Impact | Fix Deployed |
| :--- | :--- | :--- | :--- | :--- |
| **BUG-001** | `contour.rs` | Global extremum picked tab tips instead of corners | High: 30% misclassification | Multi-candidate quad geometry optimization + $r_{\text{est}}$ normalization |
| **BUG-002** | `contour.rs` | Fixed pixel constants broke across varying zoom levels | High: Broke macro webcam use | Dynamic scaling $k_{\text{span}} \propto n / 36$ |
| **BUG-003** | `contour.rs` | Corner jitter on transition fillets flipped Tab/Hole sign | Medium: Live visual wobble | Trimmed fillet guard bands + central 60% median curvature |
| **BUG-004** | `App.tsx` | CMOS sensor shot noise drifted corner coords | Medium: Annoying visual jitter | Velocity-gated deadband + temporal EMA filter |
| **BUG-005** | `generate_mat.py` | Calibration marks bled into 400x400 stage | High: False foreground blobs | Mat v5.0 outward L-crosshairs + 2% homography inset |
| **BUG-006** | `lib.rs` | Non-uniform lighting caused Otsu binarization failure | High: Segmentation failure | 85th percentile perimeter background color sampling |
| **BUG-007** | `web-app` / Test | Missing `detected_corners` in ground truth JSON | Medium: Tooling opacity | Schema extended to track both CV and human-labeled corners |
| **BUG-008** | `contour.rs` | Edge chords used raw contour pts instead of refined corners + 1-pass step noise | Medium: Baseline wobble & rough curves | Synchronized edge start/end corners + 3-pass Gaussian smoothing filter |
| **BUG-009** | `contour.rs` | Inner tab-neck fillets formed false parallelograms & border straight-cut threshold failed | High: 50px corner error & border misclassification | Topological convexity gating, 5px zero-crossing penalty, relative edge depth bimodality |

---

## Architectural Guardrails Going Forward

1. **Automated Regression Suite Gate:** No changes to `contour.rs` or `lib.rs` may be merged unless `cargo test --release test_ground_truth_benchmarks` passes 100% on all physical fixtures (currently **90/90**).
2. **Deterministic Corner Invariants:** The quad optimizer must always return strictly 4 non-overlapping corners ordered clockwise.
3. **Guard Bands on Edge Geometry:** Never sample curvature within $8\%$ arc length of a corner vertex when determining edge type or computing curve matching signatures.
4. **Decoupled Physics & Rendering:** Temporal smoothing filters (deadband, EMA) live strictly in the UI/session presentation layer; pure CV functions in `contour.rs` remain completely stateless and deterministic.
