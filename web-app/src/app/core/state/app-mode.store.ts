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

  // Telemetry signals
  readonly fps = signal<number>(60);
  readonly wasmMemoryMb = signal<number>(4.2);
  readonly wasmLatencyMs = signal<number>(0.04);
  readonly isWasmReady = signal<boolean>(true);

  setMode(mode: AppMode): void {
    this._activeMode.set(mode);
  }

  toggleLeftRail(): void {
    this._isLeftRailCollapsed.update(collapsed => !collapsed);
  }

  setLeftRailCollapsed(collapsed: boolean): void {
    this._isLeftRailCollapsed.set(collapsed);
  }
}
