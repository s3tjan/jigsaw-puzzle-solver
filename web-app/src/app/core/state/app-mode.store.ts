import { Injectable, signal, computed } from '@angular/core';
import { AppMode } from '../models/operator.model';

@Injectable({
  providedIn: 'root'
})
export class AppModeStore {
  // Current active operational mode
  private readonly _activeMode = signal<AppMode>('WORKBENCH');
  readonly activeMode = this._activeMode.asReadonly();

  // Workbench Left Rail collapse state (prevents visual crowding during F3 assembly)
  private readonly _isLeftRailCollapsed = signal<boolean>(false);
  readonly isLeftRailCollapsed = this._isLeftRailCollapsed.asReadonly();

  // Command palette state (Section 6.5 opaque transient UI)
  private readonly _isCommandPaletteOpen = signal<boolean>(false);
  readonly isCommandPaletteOpen = this._isCommandPaletteOpen.asReadonly();

  setMode(mode: AppMode): void {
    this._activeMode.set(mode);
  }

  toggleLeftRail(): void {
    this._isLeftRailCollapsed.update(collapsed => !collapsed);
  }

  openCommandPalette(): void {
    this._isCommandPaletteOpen.set(true);
  }

  closeCommandPalette(): void {
    this._isCommandPaletteOpen.set(false);
  }

  toggleCommandPalette(): void {
    this._isCommandPaletteOpen.update(open => !open);
  }
}
