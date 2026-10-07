import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../core/state/app-mode.store';
import { BoardStore } from '../../core/state/board.store';
import { InventoryStore } from '../../core/state/inventory.store';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <footer class="status-root border-t font-mono">
      <div class="status-section">
        <span class="indicator ok">●</span>
        <span>SYS: READY</span>
      </div>

      <div class="status-section">
        <span class="muted">MODE:</span>
        <span>{{ appModeStore.activeMode() }}</span>
      </div>

      <div class="status-section">
        <span class="muted">FRONTIER:</span>
        <span>{{ boardStore.frontierCount() }} SLOTS</span>
      </div>

      <div class="status-section">
        <span class="muted">PLACED:</span>
        <span>{{ boardStore.placedCount() }} / {{ boardStore.totalSlots }}</span>
      </div>

      <div class="status-section">
        <span class="muted">INGESTED:</span>
        <span>{{ inventoryStore.totalIngested() }} / {{ inventoryStore.targetTotal }}</span>
      </div>

      <!-- Right side shortcuts & system telemetry -->
      <div class="status-right">
        @if (appModeStore.activeMode() === 'WORKBENCH') {
          <div class="status-section highlight">
            <span>RAIL: {{ appModeStore.isLeftRailCollapsed() ? 'COLLAPSED' : 'EXPANDED' }} [TAB / B]</span>
          </div>
        }
        <div class="status-section">
          <span class="muted">MEM:</span>
          <span>{{ appModeStore.wasmMemoryMb() }} MB</span>
        </div>
        <div class="status-section">
          <span class="muted">FPS:</span>
          <span>{{ appModeStore.fps() }}</span>
        </div>
      </div>
    </footer>
  `,
  styles: [`
    .status-root {
      height: 24px;
      background: var(--bg-surface-secondary);
      display: flex;
      align-items: center;
      padding: 0 8px;
      gap: 16px;
      font-size: 11px;
      color: var(--text-primary);
    }

    .status-section {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .status-section.highlight {
      font-weight: 600;
      color: var(--text-primary);
      background: var(--bg-surface);
      padding: 1px 6px;
      border: var(--border-rule);
    }

    .status-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .muted {
      color: var(--text-muted);
    }

    .indicator.ok {
      color: var(--status-ok);
      font-size: 10px;
    }
  `]
})
export class StatusBarComponent {
  readonly appModeStore = inject(AppModeStore);
  readonly boardStore = inject(BoardStore);
  readonly inventoryStore = inject(InventoryStore);
}
