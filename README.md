# Jigsaw Puzzle Solver

A real-time physical jigsaw puzzle solver using **Rust**, **WebAssembly (WASM)**, and **Angular / TypeScript**. Features camera dewarping via projective homography, sub-pixel corner detection, geometric edge classification, and resident 4×4 spatial probability density heatmaps.

---

## 🚀 Quick Start & Development

### Prerequisites
- [Rust & Cargo](https://rustup.rs/) (edition 2024 / stable)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [Node.js](https://nodejs.org/) (v18+) & npm

---

### 1. Build the Rust WASM CV Engine
Whenever you change Rust files in `cv-engine/src/`:

```bash
cd cv-engine
wasm-pack build --target web --out-dir ../web-app/src/pkg
```

Run CV tests and benchmarks:
```bash
cargo test
```

---

### 2. Run the Web Application
Start the local development server (or run `make all` from the repository root):

```bash
# Option A: Root Makefile (Builds WASM + Starts Angular dev server)
make all

# Option B: Direct npm command
cd web-app
npm install        # (First time only)
npm start
```

- Open `http://localhost:4200/` in your browser.
- **To restart the server**: Press `Ctrl + C` in the running terminal, then run `make all` or `npm start` again.

---

### 3. Production Build & Test Suite
Verify production compilation and run all tests:

```bash
# Build both WASM and Angular production bundles
make build

# Run both Rust and Angular test suites
make test
```

---

## 📁 Repository Structure

```
jigsaw-puzzle-solver/
├── cv-engine/                 # Core computer vision engine in Rust
│   ├── src/
│   │   ├── contour.rs         # Radial boundary tracing, quad solving, corner detection
│   │   ├── fiducial.rs        # Bullseye sub-pixel centroid snapping & MTF focus
│   │   ├── homography.rs      # DLT 3x3 projective rectification & dewarping
│   │   ├── matcher.rs         # 4-edge polarity classification & tab measurement
│   │   ├── poster.rs          # CIELAB feature vectors & K-means tray clustering
│   │   └── lib.rs             # WASM bindings and continuous mat ingestion pipeline
│   ├── datasets/
│   │   ├── archive/v1/        # 90 historical ground-truth fixtures
│   │   └── ground_truth/      # Active ground-truth capture directory
│   └── tests/                 # Benchmark & smoothness regression tests
├── web-app/                   # Standalone Angular 19 operator workstation
│   ├── src/
│   │   ├── app/core/          # Typed WASM bridge, CameraService, Storage, Stores
│   │   ├── app/features/      # Optics (Alt+2), Poster (Alt+1), Scanner (Alt+3), Workbench (Alt+4)
│   │   └── pkg/               # wasm-pack generated ES module bindings
│   └── public/                # WASM binary and static assets
├── docs/                      # Architecture Decision Records & Postmortems
│   ├── ADR.md                 # Architecture Decision Records
│   └── POSTMORTEM_CV_ENGINE.md# Technical postmortem of vision bug fixes
├── generate_mat.py            # Calibration mat generator script
└── ROADMAP.md                 # Project roadmap and milestone tracker
```
├── generate_mat.py            # Calibration mat generator script
└── ROADMAP.md                 # Project roadmap and milestone tracker
```

---

## 📖 Documentation
- [Technical Architecture & Roadmap](ROADMAP.md): Unified master specification covering physical constraints, 3-step practical assembly workflow, spatial probability density heatmaps, and milestone status.
- [Architecture Decision Records (ADRs)](docs/ADR.md):
  - **ADR-001**: Ground-truth strategy, edge-corner synchronization, and iterated Gaussian contour smoothing.
  - **ADR-002**: Spatial probability density heatmaps and tabletop assembly synergy (superseding automated 1D perimeter loop chaining).
  - **ADR-003**: Frontend architecture pivot to Angular (complete replacement of monolithic React client with enterprise standalone Angular services and signals).
- [CV Engine Postmortem](docs/POSTMORTEM_CV_ENGINE.md): Incident log and resolution breakdown for corner detection, optical noise deadband, and segmentation invariants.
