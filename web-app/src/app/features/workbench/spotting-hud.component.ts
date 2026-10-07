import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardStore } from '../../core/state/board.store';

@Component({
  selector: 'app-spotting-hud',
  standalone: true,
  imports: [CommonModule],
  template: `
    <aside class="spotting-root border-l">
      <div class="inverted-header">
        <span>INSPECTOR: TARGET SLOT</span>
      </div>

      <div class="inspector-content">
        @if (boardStore.selectedSlot(); as slot) {
          <!-- Key-Value Properties Table -->
          <table class="inspector-table border-b">
            <tbody>
              <tr>
                <td class="prop-key">SLOT COORDINATES</td>
                <td class="prop-val font-mono">R{{ slot.r }} C{{ slot.c }}</td>
              </tr>
              <tr>
                <td class="prop-key">REQUIRED POLARITY</td>
                <td class="prop-val font-mono">
                  N:{{ slot.requiredPolarities?.north }} E:{{ slot.requiredPolarities?.east }} S:{{ slot.requiredPolarities?.south }} W:{{ slot.requiredPolarities?.west }}
                </td>
              </tr>
            </tbody>
          </table>

          <div class="inverted-header">
            <span>CANDIDATE RETRIEVAL #1</span>
          </div>

          @if (boardStore.candidates()[0]; as topCandidate) {
            <table class="inspector-table border-b">
              <tbody>
                <tr>
                  <td class="prop-key">PIECE ID</td>
                  <td class="prop-val font-mono">#{{ topCandidate.id }}</td>
                </tr>
                <tr>
                  <td class="prop-key">PHYSICAL TRAY</td>
                  <td class="prop-val font-mono">TRAY-0{{ topCandidate.trayId }} [{{ topCandidate.trayName }}]</td>
                </tr>
                <tr>
                  <td class="prop-key">MATCH SCORE</td>
                  <td class="prop-val font-mono text-right">{{ (topCandidate.confidence * 100).toFixed(1) }}%</td>
                </tr>
                <tr>
                  <td class="prop-key">CARDINAL ROTATION</td>
                  <td class="prop-val font-mono">{{ topCandidate.rotationLabel }}</td>
                </tr>
                <tr>
                  <td class="prop-key">TAB WIDTH (MM)</td>
                  <td class="prop-val font-mono text-right">{{ topCandidate.tabWidthMm.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>

            <!-- 1:1 Scale Silhouette Specimen Frame -->
            <div class="specimen-frame border-b font-mono">
              <span class="specimen-tag">1:1 METRIC SILHOUETTE (25MM = 96PX)</span>
              <div class="specimen-wireframe">
                WIDTH: {{ topCandidate.tabWidthMm.toFixed(2) }}MM | ORIENTATION: {{ topCandidate.rotation }}°
              </div>
            </div>
          }

          <!-- Action Controls -->
          <div class="action-footer border-t">
            <button type="button" class="btn-action active" (click)="boardStore.confirmPlacement()">
              CONFIRM PLACEMENT [ENTER]
            </button>
            <button type="button" class="btn-action" (click)="boardStore.rejectCandidate()">
              REJECT CANDIDATE [DEL]
            </button>
          </div>
        } @else {
          <div class="empty-state font-mono">
            NO RECORDS
          </div>
        }
      </div>
    </aside>
  `,
  styles: [`
    .spotting-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-surface);
      width: 100%;
    }

    .inspector-content {
      flex: 1;
      display: flex;
      flex-direction: column;
    }

    .inspector-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .inspector-table td {
      padding: 4px 8px;
      height: 28px;
      border-bottom: var(--border-rule);
    }

    .prop-key {
      width: 130px;
      color: var(--text-muted);
      font-weight: 500;
      background: var(--bg-surface-secondary);
      border-right: var(--border-rule);
      font-size: 11px;
    }

    .prop-val {
      color: var(--text-primary);
    }

    .specimen-frame {
      padding: 8px;
      background: var(--bg-surface-secondary);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .specimen-tag {
      font-size: 10px;
      color: var(--text-muted);
      letter-spacing: 0.05em;
    }

    .specimen-wireframe {
      height: 64px;
      background: var(--bg-surface);
      border: var(--border-rule);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
    }

    .action-footer {
      margin-top: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--bg-surface-secondary);
    }

    .btn-action {
      height: 30px;
      width: 100%;
    }

    .empty-state {
      padding: 16px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }
  `]
})
export class SpottingHudComponent {
  readonly boardStore = inject(BoardStore);
}
