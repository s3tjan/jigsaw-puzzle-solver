/* tslint:disable */
/* eslint-disable */

/**
 * Scans, segments, and analyzes the puzzle piece from a rectified RGBA buffer.
 * Robust against white bond paper background: pieces have distinct contrast from the white floor.
 */
export function analyze_staged_piece(dewarped_pixels: Uint8Array, width: number, height: number, sensitivity: number): any;

/**
 * Dewarp the specified 4-point quadrilateral from src_pixels into a rectified dst_w x dst_h RGBA buffer.
 * Inset crops inward by 2% (100mm fiducials to 96mm stage) so only the clean staging arena is captured.
 */
export function dewarp_quad(src_pixels: Uint8Array, src_w: number, src_h: number, p0_x: number, p0_y: number, p1_x: number, p1_y: number, p2_x: number, p2_y: number, p3_x: number, p3_y: number, dst_w: number, dst_h: number, k1: number): Uint8Array;

/**
 * WASM entry point: Computes the grid slots layout.
 */
export function get_poster_grid_slots(cols: number, rows: number, img_w: number, img_h: number, phys_w_mm: number, phys_h_mm: number): any;

/**
 * WASM entry point: Extracts a high-resolution slot thumbnail and color cue metadata for Mode C (Targeted Hole-Filling).
 */
export function get_slot_preview(rgba: Uint8Array, img_w: number, img_h: number, cols: number, rows: number, col: number, row: number): any;

/**
 * Identifies a staged piece against the pool of stored pieces
 */
export function identify_staged_piece_wasm(query_edges_json: string, stored_pieces_json: string): any;

/**
 * WASM entry point: Ingests reference poster RGBA and stores precomputed 4x4 spatial descriptors
 * directly in Rust WebAssembly linear memory. Zero JSON serialization overhead!
 */
export function init_master_poster_spatial(poster_rgba: Uint8Array, poster_w: number, poster_h: number, cols: number, rows: number): number;

/**
 * Fast candidate search running against precomputed slot descriptors in < 2ms.
 */
export function locate_piece_fast(piece_rgba: Uint8Array, piece_mask: Uint8Array, piece_w: number, piece_h: number, precomputed_slots_json: any, is_border_hint: boolean, is_corner_hint: boolean): any;

/**
 * WASM entry point: Locates a piece in < 3ms directly against resident WASM memory.
 */
export function locate_piece_spatial(piece_rgba: Uint8Array, piece_mask: Uint8Array, piece_w: number, piece_h: number, is_border_hint: boolean, is_corner_hint: boolean, corners: Float32Array, flat_edges: Uint8Array): any;

/**
 * Computes the forward mapping matrix from dewarped stage coordinates (dst_w x dst_h)
 * back to camera pixel coordinates, taking into account lens distortion k1.
 */
export function map_dewarped_points_to_camera(points: Float32Array, src_w: number, src_h: number, p0_x: number, p0_y: number, p1_x: number, p1_y: number, p2_x: number, p2_y: number, p3_x: number, p3_y: number, dst_w: number, dst_h: number, k1: number): Float32Array;

/**
 * Measures real-time optical focus MTF score [0, 100]% using high-frequency gradient energy
 */
export function measure_stage_focus(pixels: Uint8Array, width: number, height: number, p0_x: number, p0_y: number, p1_x: number, p1_y: number, p2_x: number, p2_y: number, p3_x: number, p3_y: number): number;

/**
 * Precomputes visual descriptors (CIELAB color & Sobel orientation histogram) for all grid slots
 * once when poster is ingested, eliminating per-frame convolutions.
 */
export function precompute_poster_slots(poster_rgba: Uint8Array, poster_w: number, poster_h: number, cols: number, rows: number): any;

/**
 * WASM entry point: Ingests an RGBA poster image buffer, computes metadata and multi-scale pyramids,
 * and returns the serialized MasterPoster structure.
 */
export function process_poster_rgba(rgba: Uint8Array, width: number, height: number, total_pieces: number, cols: number, rows: number, phys_w_mm: number, phys_h_mm: number, max_pyramid_levels: number): any;

/**
 * Snaps a manual seed coordinate to the exact sub-pixel center of the nearest fiducial bullseye
 */
export function snap_fiducial_corner(pixels: Uint8Array, width: number, height: number, seed_x: number, seed_y: number, radius: number): Float32Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly analyze_staged_piece: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly dewarp_quad: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number, number];
    readonly get_poster_grid_slots: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly get_slot_preview: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly identify_staged_piece_wasm: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly init_master_poster_spatial: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly locate_piece_fast: (a: number, b: number, c: number, d: number, e: number, f: number, g: any, h: number, i: number) => [number, number, number];
    readonly locate_piece_spatial: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number];
    readonly map_dewarped_points_to_camera: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number];
    readonly measure_stage_focus: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => number;
    readonly precompute_poster_slots: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly process_poster_rgba: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly snap_fiducial_corner: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
