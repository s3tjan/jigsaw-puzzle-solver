import { Injectable } from '@angular/core';

export interface PolarityArchetype {
  id: number;
  name: string;
  shortLabel: string;
  description: string;
  color: string;
  maxCapacity: number;
}

/**
 * Deterministic Polarity Archetype Trays
 * Categorizes physical puzzle pieces strictly by edge tab/hole configuration.
 * Zero fuzzy color mis-sorting: pieces are 100% reliably placed into these physical trays.
 */
export const POLARITY_TRAYS: PolarityArchetype[] = [
  {
    id: 0,
    name: 'Border & Corners',
    shortLabel: 'BORDER',
    description: 'Pieces with 1 or 2 flat edges',
    color: '#0f172a', // Deep slate
    maxCapacity: 124,
  },
  {
    id: 1,
    name: '2-Tab Opposite',
    shortLabel: '2-TAB OPP',
    description: 'Tabs on opposite sides (T-H-T-H or H-T-H-T)',
    color: '#2563eb', // Blue
    maxCapacity: 250,
  },
  {
    id: 2,
    name: '2-Tab Adjacent',
    shortLabel: '2-TAB ADJ',
    description: 'Tabs on adjacent sides (T-T-H-H or H-H-T-T)',
    color: '#059669', // Emerald
    maxCapacity: 250,
  },
  {
    id: 3,
    name: '3-Tab (1-Hole)',
    shortLabel: '3-TAB',
    description: '3 tabs and 1 hole (T-T-T-H)',
    color: '#d97706', // Amber
    maxCapacity: 250,
  },
  {
    id: 4,
    name: '3-Hole (1-Tab)',
    shortLabel: '3-HOLE',
    description: '3 holes and 1 tab (H-H-H-T)',
    color: '#7c3aed', // Purple
    maxCapacity: 250,
  },
  {
    id: 5,
    name: '4-Tab / 4-Hole',
    shortLabel: '4-TAB / 4-HOLE',
    description: 'All 4 tabs or all 4 holes',
    color: '#dc2626', // Red
    maxCapacity: 30,
  },
];

/**
 * Classifies a piece's 4 cardinal edge polarities into its exact mechanical tray.
 */
export function classifyPolarityArchetype(
  polarities: [string, string, string, string]
): PolarityArchetype {
  const norm = polarities.map(p => p.toUpperCase());
  const flatCount = norm.filter(p => p === 'FLAT').length;

  // Frame pieces (Border & Corners)
  if (flatCount >= 1) {
    return POLARITY_TRAYS[0];
  }

  const tabCount = norm.filter(p => p === 'TAB').length;
  const holeCount = norm.filter(p => p === 'HOLE').length;

  if (tabCount === 4 || holeCount === 4) {
    return POLARITY_TRAYS[5];
  }
  if (tabCount === 3) {
    return POLARITY_TRAYS[3];
  }
  if (holeCount === 3) {
    return POLARITY_TRAYS[4];
  }

  // 2 Tabs & 2 Holes: Check if Opposite or Adjacent
  // E0 opposite to E2, E1 opposite to E3
  const isOpposite = norm[0] === norm[2] && norm[1] === norm[3];
  if (isOpposite) {
    return POLARITY_TRAYS[1];
  } else {
    return POLARITY_TRAYS[2];
  }
}

