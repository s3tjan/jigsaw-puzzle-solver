import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../core/state/app-mode.store';
import { ToolbarComponent } from './toolbar.component';
import { StatusBarComponent } from './status-bar.component';
import { FrontierListComponent } from '../workbench/frontier-list.component';
import { WorkbenchCanvasComponent } from '../workbench/workbench-canvas.component';
import { SpottingHudComponent } from '../workbench/spotting-hud.component';
import { InventoryStore } from '../../core/state/inventory.store';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [
    CommonModule,
    ToolbarComponent,
    StatusBarComponent,
    FrontierListComponent,
    WorkbenchCanvasComponent,
    SpottingHudComponent
  ],
  template: `
    <div class="shell-root">
      <!-- 30px Utility Toolbar -->
      <app-toolbar></app-toolbar>

      <!-- Main Operational Split Workspace -->
      <main class="workspace-split">
        <!-- MODE: WORKBENCH (F3) -->
        @if (appModeStore.activeMode() === 'WORKBENCH') {
          <!-- Left Rail: Frontier Queue (Instantly Collapsible to prevent visual crowding) -->
          @if (!appModeStore.isLeftRailCollapsed()) {
            <div class="rail-pane">
              <app-frontier-list></app-frontier-list>
            </div>
          } @else {
            <div class="rail-collapsed-strip" (click)="appModeStore.toggleLeftRail()" title="Click or press [Tab] to expand">
              <span class="collapsed-glyph">▶</span>
              <span class="collapsed-label font-mono">FRONTIER</span>
            </div>
          }

          <!-- Center Workspace: 34x26 Board Canvas -->
          <div class="canvas-pane">
            <app-workbench-canvas></app-workbench-canvas>
          </div>

          <!-- Right Inspector: Spotting HUD -->
          <div class="inspector-pane">
            <app-spotting-hud></app-spotting-hud>
          </div>
        }

        <!-- MODE: INGESTION (F1) -->
        @if (appModeStore.activeMode() === 'INGESTION') {
          <div class="mode-placeholder">
            <div class="inverted-header">CONTINUOUS MAT INGESTION (1080P FEED)</div>
            <div class="placeholder-body font-mono">
              [WEBRTC VIDEO STREAM: ACTIVE] | MAT FIDUCIALS: C1-C4 GROUNDED | EYE-FREE COLOR FLASH: READY
            </div>
          </div>
        }

        <!-- MODE: POSTER_STUDIO (F2) -->
        @if (appModeStore.activeMode() === 'POSTER_STUDIO') {
          <div class="mode-placeholder">
            <div class="inverted-header">POSTER ANALYSIS & TRAY CLUSTERING STUDIO</div>
            <div class="placeholder-body font-mono">
              [8 PHYSICAL TRAYS BALANCED: <= 125 PCS] | K-MEANS WEIGHTS: [COLOR: 0.45, TEXTURE: 0.35, SPATIAL: 0.20]
            </div>
          </div>
        }
      </main>

      <!-- 24px Bottom Telemetry Status Strip -->
      <app-status-bar></app-status-bar>
    </div>
  `,
  styles: [`
    .shell-root {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: var(--bg-app);
    }

    .workspace-split {
      flex: 1;
      display: flex;
      overflow: hidden;
      position: relative;
    }

    .rail-pane {
      width: 280px;
      height: 100%;
      flex-shrink: 0;
    }

    .rail-collapsed-strip {
      width: 22px;
      height: 100%;
      background: var(--bg-surface-secondary);
      border-right: var(--border-rule);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: 8px;
      cursor: pointer;
      gap: 12px;
    }

    .rail-collapsed-strip:hover {
      background: var(--bg-surface-hover);
    }

    .collapsed-glyph {
      font-size: 10px;
      color: var(--text-muted);
    }

    .collapsed-label {
      writing-mode: vertical-rl;
      text-orientation: mixed;
      font-size: 10px;
      letter-spacing: 0.1em;
      color: var(--text-muted);
    }

    .canvas-pane {
      flex: 1;
      height: 100%;
      overflow: hidden;
    }

    .inspector-pane {
      width: 320px;
      height: 100%;
      flex-shrink: 0;
    }

    .mode-placeholder {
      flex: 1;
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      margin: 0;
      border: none;
    }

    .placeholder-body {
      padding: 8px;
      color: var(--text-muted);
    }
  `]
})
export class ShellComponent {
  readonly appModeStore = inject(AppModeStore);
}
