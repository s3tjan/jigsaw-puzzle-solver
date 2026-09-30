# Jigsaw Puzzle Solver

A real-time physical jigsaw puzzle solver using **Rust**, **WebAssembly (WASM)**, and **React/TypeScript**. Features camera dewarping via projective homography, sub-pixel corner detection, and geometric edge classification.

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
Start the local development server:

```bash
cd web-app
npm install        # (First time only)
npm run dev
```

- Open `http://localhost:5173/` in your browser.
- **To restart the server**: Press `Ctrl + C` in the running terminal, then run `npm run dev` again.

---

### 3. Production Build
Verify production compilation of both WASM and TypeScript bundles:

```bash
cd web-app
npm run build
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
│   │   └── lib.rs             # WASM bindings and thresholding pipeline
│   ├── datasets/
│   │   ├── archive/v1/        # 90 historical ground-truth fixtures
│   │   └── ground_truth/      # Active ground-truth capture directory
│   └── tests/                 # Benchmark & smoothness regression tests
├── web-app/                   # React frontend + UI labeling workbench
│   ├── src/                   # React UI, camera loop, canvas diagnostics
│   └── public/                # Calibration mat printable targets (PDF, SVG, PNG)
├── docs/                      # Architecture Decision Records & Postmortems
│   ├── ADR.md                 # Architecture Decision Records
│   └── POSTMORTEM_CV_ENGINE.md# Technical postmortem of vision bug fixes
├── generate_mat.py            # Calibration mat generator script
└── ROADMAP.md                 # Project roadmap and milestone tracker
```

---

## 📖 Documentation
- [Architecture Decision Record (ADR-001)](docs/ADR.md): Ground-truth strategy, edge-corner synchronization, and iterated Gaussian contour smoothing.
- [CV Engine Postmortem](docs/POSTMORTEM_CV_ENGINE.md): Incident log and resolution breakdown for corner detection, optical noise deadband, and segmentation invariants.
- [Technical Roadmap](ROADMAP.md): System architecture overview and phase milestone progress.
