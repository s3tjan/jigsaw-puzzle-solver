# Technical Post-Mortem & Architecture Gap Analysis

**Date:** 2026-10-06  
**Context:** Phase 6 Frontend Modernization (React Legacy Archival & Angular Architecture Reset)  
**Author:** Frontend Systems Architecture  

---

## 1. Executive Summary

During the initial bootstrap and migration of the jigsaw puzzle solver frontend from the monolithic React implementation (`web-app-legacy/`) to the standalone Angular architecture (`web-app/`), the project successfully established the core decoupled services, signal stores, and a light-industrial operator layout complying with [.agents/rules/senior-frontend.md](file:///home/stbn/projects/jigsaw-puzzle-solver/.agents/rules/senior-frontend.md).

However, an engineering audit identified several architectural, reactivity, and type-system deficiencies introduced during rapid scaffolding. This document details each finding, root cause, impact, and concrete remediation path.

---

## 2. Identified Issues & Technical Debt

### Issue 1: Canvas Rendering & Signal Reactivity Desynchronization
- **Severity:** High
- **Component:** [WorkbenchCanvasComponent](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/features/workbench/workbench-canvas.component.ts) / [BoardStore](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/core/stores/board.store.ts)
- **Root Cause:** Redraw execution (`this.render()`) is invoked exclusively within imperative DOM event handlers (`mousemove`, `mouseup`, `wheel`, and `ResizeObserver`). The 2D canvas does not register an Angular `effect()` on state changes.
- **Impact:** When `BoardStore.placedSlots` or `InventoryStore.pieces` mutate asynchronously (such as initial IndexedDB resolution upon startup, piece removal from inspector, or batch import), the board canvas does not redraw. The visual board remains blank or stale until a user manually moves the cursor or triggers a pan/zoom gesture.
- **Remediation:**
  Inject `Injector` into `WorkbenchCanvasComponent` or construct an `effect()` in the constructor:
  ```typescript
  effect(() => {
    // Register reactive signal dependencies
    this.boardStore.placedSlots();
    this.boardStore.hoveredSlot();
    this.render();
  });
  ```

---

### Issue 2: WASM Module Typelessness & Memory Boundary Risks
- **Severity:** High
- **Component:** [WasmService](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/core/services/wasm.service.ts)
- **Root Cause:** To circumvent build-time static module resolution errors during `ng build`, `WasmService` uses a dynamic import via `Function('url', 'return import(url)')` and stores the module as untyped `any`.
- **Impact:**
  1. Complete loss of compile-time type checking provided by [cv-engine/pkg/cv_engine.d.ts](file:///home/stbn/projects/jigsaw-puzzle-solver/cv-engine/pkg/cv_engine.d.ts) (`WasmProcessedPiece`, `WasmHomographyResult`, `locate_piece_spatial`, `find_piece_corners_subpixel`).
  2. Future CV integration code lacks type guarantees when allocating and passing `Uint8Array` / `Float64Array` buffers through WebAssembly linear memory (`wasm.memory.buffer`), risking silent memory corruption or runtime panics.
- **Remediation:**
  1. Import the generated type declarations from `cv-engine/pkg/cv_engine.d.ts` as type-only references:
     ```typescript
     import type * as CvEngineTypes from '../../../../../cv-engine/pkg/cv_engine';
     ```
  2. Type the internal module reference as `typeof CvEngineTypes | null` and expose typed methods for each WASM entry point.

---

### Issue 3: Missing Global Keyboard Navigation Loop
- **Severity:** Medium
- **Component:** [App](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/app.ts) / [PieceTreeComponent](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/features/inventory/piece-tree.component.ts)
- **Root Cause:** Shortcut tags are rendered in the UI (`[W]`, `[C]`, `[P]`), but no corresponding `window:keydown` listeners or table row key-traversal handlers are implemented.
- **Impact:** Fails the core requirement of [.agents/rules/senior-frontend.md](file:///home/stbn/projects/jigsaw-puzzle-solver/.agents/rules/senior-frontend.md) ("The tool is keyboard-first. Every primary action has a visible or documented shortcut. Selected rows are arrow-navigable."). The user must use mouse clicks for navigation.
- **Remediation:**
  1. Add a global `@HostListener('window:keydown', ['$event'])` on `AppComponent` for hotkeys `W`, `C`, `P`, and `Escape`.
  2. Implement `ArrowUp` / `ArrowDown` navigation inside `PieceTreeComponent` to cycle through pieces without pointer input.

---

### Issue 4: High-DPI (Retina) Canvas Pixel Discretization
- **Severity:** Medium
- **Component:** [WorkbenchCanvasComponent](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/features/workbench/workbench-canvas.component.ts#L101-L106)
- **Root Cause:** Canvas internal pixel buffer is set directly to CSS pixel dimensions:
  ```typescript
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  ```
- **Impact:** On displays where `window.devicePixelRatio > 1` (standard for modern workstations, 4K monitors, and laptops), 1px grid rules, piece outlines, and text HUDs will appear blurry due to bicubic upscaling.
- **Remediation:**
  Multiply internal dimensions by `window.devicePixelRatio` and apply device pixel ratio scaling to the 2D rendering context:
  ```typescript
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(container.clientWidth * dpr);
  canvas.height = Math.floor(container.clientHeight * dpr);
  ctx.scale(dpr, dpr);
  ```

---

### Issue 5: Hardcoded Grid Dimension Inconsistency
- **Severity:** Medium
- **Component:** [BoardStore](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/core/stores/board.store.ts#L5-L16) / [PieceModel](file:///home/stbn/projects/jigsaw-puzzle-solver/web-app/src/app/core/models/piece.model.ts)
- **Root Cause:** `DEFAULT_BOARD_DIMENSIONS` declares `26 × 34 = 884` (the 124 border loop spec from physical tests), while `BoardStore.dimensions` initial signal sets `28 × 36 = 1,008` (the total puzzle piece count). The configuration is neither persisted to IndexedDB nor adjustable via UI.
- **Impact:** Board capacity calculations, border slot coordinates, and heatmap pruning dimensions diverge depending on which constant is evaluated.
- **Remediation:**
  Unify puzzle dimensions under a persisted `BoardConfig` in IndexedDB (reusing the legacy database schema) and expose grid dimensions in the inspector settings.

---

### Issue 6: Asset Synchronization Drift in Development
- **Severity:** Low
- **Component:** `package.json` (`copy:wasm`)
- **Root Cause:** `npm run copy:wasm` is bound only to `prebuild` and `prestart`. When Rust WASM code (`cv-engine/src/*.rs`) is edited and recompiled via `wasm-pack` while `ng serve` is active, the dev server serves outdated WASM binaries.
- **Impact:** Developer must manually stop and restart `ng serve` or run `npm run copy:wasm` to reflect Rust algorithm changes.
- **Remediation:**
  Add a cargo watch script or automated build watch hook that synchronizes `cv-engine/pkg` to `web-app/public/wasm` upon crate compilation.

---

## 3. Action Plan & Priority Matrix

| Item | Problem | Severity | Target Phase |
| :--- | :--- | :--- | :--- |
| **GAP-01** | Connect `BoardStore` and `InventoryStore` signals to `WorkbenchCanvasComponent` via `effect()` | High | Immediate (Phase 6.1) |
| **GAP-02** | Import and enforce static type safety from `cv-engine.d.ts` in `WasmService` | High | Immediate (Phase 6.1) |
| **GAP-03** | Implement keyboard navigation loop (`[W]`, `[C]`, `[P]`, `ArrowUp`/`Down`) | Medium | Phase 6.1 |
| **GAP-04** | Implement `window.devicePixelRatio` canvas backing buffer scaling | Medium | Phase 6.1 |
| **GAP-05** | Persist and harmonize `BoardConfig` dimensions in IndexedDB | Medium | Phase 6.2 |
| **GAP-06** | Automate WASM asset synchronization during active dev server sessions | Low | Phase 6.2 |
