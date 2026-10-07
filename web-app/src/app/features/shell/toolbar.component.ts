import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../core/state/app-mode.store';
import { AppMode } from '../../core/models/operator.model';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <header class="toolbar-root border-b">
      <!-- Mode Selector (F1-F3) -->
      <div class="mode-cluster">
        <button 
          type="button" 
          class="mode-btn" 
          [class.active]="appModeStore.activeMode() === 'INGESTION'"
          (click)="setMode('INGESTION')"
          title="Shortcut: F1"
        >
          <span class="shortcut-hint font-mono">[F1]</span>INGESTION
        </button>
        <button 
          type="button" 
          class="mode-btn" 
          [class.active]="appModeStore.activeMode() === 'POSTER_STUDIO'"
          (click)="setMode('POSTER_STUDIO')"
          title="Shortcut: F2"
        >
          <span class="shortcut-hint font-mono">[F2]</span>POSTER STUDIO
        </button>
        <button 
          type="button" 
          class="mode-btn" 
          [class.active]="appModeStore.activeMode() === 'WORKBENCH'"
          (click)="setMode('WORKBENCH')"
          title="Shortcut: F3"
        >
          <span class="shortcut-hint font-mono">[F3]</span>WORKBENCH HUD
        </button>
      </div>

      <div class="divider"></div>

      <!-- Functional Optics Calibration Action (OPT-03) -->
      <button type="button" class="action-btn" title="Open K1 Distortion Calibration Modal">
        CALIBRATE OPTICS [OPT-03]
      </button>

      <!-- Right Telemetry Readouts -->
      <div class="telemetry-cluster">
        <div class="telemetry-item">
          <span class="label">SCALE:</span>
          <span class="val font-mono">96px/25mm</span>
        </div>
        <div class="telemetry-item">
          <span class="label">K1:</span>
          <span class="val font-mono">0.000</span>
        </div>
        <div class="telemetry-item">
          <span class="status-indicator">●</span>
          <span class="label">WASM:</span>
          <span class="val font-mono">{{ appModeStore.wasmLatencyMs() }}ms</span>
        </div>
      </div>
    </header>
  `,
  styles: [`
    .toolbar-root {
      height: 30px;
      background: var(--bg-surface);
      display: flex;
      align-items: center;
      padding: 0 8px;
      gap: 8px;
    }

    .divider {
      width: 1px;
      height: 18px;
      background: #d4d4d4;
    }

    .mode-cluster {
      display: flex;
      gap: 4px;
    }

    .mode-btn, .action-btn {
      height: 24px;
      padding: 0 8px;
      font-size: 12px;
    }

    .shortcut-hint {
      font-size: 11px;
      color: var(--text-muted);
      margin-right: 4px;
    }

    .action-btn {
      background: var(--bg-surface-secondary);
      border: var(--border-rule);
    }

    .telemetry-cluster {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
    }

    .telemetry-item {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .label {
      color: var(--text-muted);
      font-weight: 500;
    }

    .val {
      color: var(--text-primary);
    }

    .status-indicator {
      color: var(--status-ok);
      font-size: 10px;
    }
  `]
})
export class ToolbarComponent {
  readonly appModeStore = inject(AppModeStore);

  setMode(mode: AppMode): void {
    this.appModeStore.setMode(mode);
  }
}
