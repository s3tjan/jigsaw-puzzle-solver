import { TestBed } from '@angular/core/testing';
import { BoardStore } from './board.store';

describe('BoardStore', () => {
  let store: BoardStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(BoardStore);
  });

  it('should initialize with correct 1,008-piece puzzle grid geometry', () => {
    expect(store.cols).toBe(36);
    expect(store.rows).toBe(28);
    expect(store.totalSlots).toBe(1008);
    expect(store.borderSlotsCount).toBe(124);
    expect(store.interiorSlotsCount).toBe(884);
  });

  it('should initialize with 124 pre-anchored border pieces', () => {
    expect(store.placedCount()).toBe(124);
  });

  it('should select an active frontier slot', () => {
    const testSlot = { r: 5, c: 5, isPlaced: false };
    store.selectSlot(testSlot);
    expect(store.selectedSlot()).toEqual(testSlot);
  });

  it('should confirm placement, advancing placed count and removing resolved slot from frontier', () => {
    const initialPlaced = store.placedCount();
    const initialFrontier = store.frontierSlots();
    const target = initialFrontier[0];

    store.selectSlot(target);
    store.confirmPlacement();

    expect(store.placedCount()).toBe(initialPlaced + 1);
    expect(store.frontierSlots().some(s => s.r === target.r && s.c === target.c)).toBeFalse();
  });

  it('should cycle candidates on rejectCandidate', () => {
    const initial = store.candidates();
    expect(initial.length).toBeGreaterThan(1);
    const firstId = initial[0].id;
    const secondId = initial[1].id;

    store.rejectCandidate();

    const updated = store.candidates();
    expect(updated[0].id).toBe(secondId);
    expect(updated[updated.length - 1].id).toBe(firstId);
  });
});
