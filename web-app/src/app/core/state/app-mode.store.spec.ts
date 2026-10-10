import { TestBed } from '@angular/core/testing';
import { AppModeStore } from './app-mode.store';

describe('AppModeStore', () => {
  let store: AppModeStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    store = TestBed.inject(AppModeStore);
  });

  it('should initialize in WORKBENCH mode', () => {
    expect(store.activeMode()).toBe('WORKBENCH');
  });

  it('should switch between operational modes', () => {
    store.setMode('POSTER');
    expect(store.activeMode()).toBe('POSTER');

    store.setMode('OPTICS');
    expect(store.activeMode()).toBe('OPTICS');

    store.setMode('INGESTION');
    expect(store.activeMode()).toBe('INGESTION');
  });

  it('should toggle left rail collapse state', () => {
    expect(store.isLeftRailCollapsed()).toBeFalse();
    store.toggleLeftRail();
    expect(store.isLeftRailCollapsed()).toBeTrue();
    store.toggleLeftRail();
    expect(store.isLeftRailCollapsed()).toBeFalse();
  });

  it('should manage command palette state', () => {
    expect(store.isCommandPaletteOpen()).toBeFalse();
    store.openCommandPalette();
    expect(store.isCommandPaletteOpen()).toBeTrue();
    store.closeCommandPalette();
    expect(store.isCommandPaletteOpen()).toBeFalse();
  });

  it('should increment scanTrigger upon triggerScanDrop', () => {
    const initial = store.scanTrigger();
    store.triggerScanDrop();
    expect(store.scanTrigger()).toBe(initial + 1);
  });
});
