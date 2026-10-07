import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardStore } from '../../core/state/board.store';
import { BoardSlot } from '../../core/models/operator.model';

@Component({
  selector: 'app-frontier-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <aside class="frontier-root border-r">
      <div class="inverted-header">
        <span>FRONTIER QUEUE ({{ boardStore.frontierCount() }})</span>
        <span class="shortcut-tag">[TAB TO HIDE]</span>
      </div>

      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 50px;">SLOT</th>
              <th style="width: 70px;">ENTROPY</th>
              <th>POLARITIES (N-E-S-W)</th>
            </tr>
          </thead>
          <tbody>
            @for (slot of boardStore.frontierSlots(); track slot.r + '-' + slot.c) {
              <tr 
                [class.selected]="isSelected(slot)"
                (click)="boardStore.selectSlot(slot)"
              >
                <td class="font-mono">R{{ slot.r }} C{{ slot.c }}</td>
                <td class="font-mono text-right">{{ slot.entropy?.toFixed(2) }}</td>
                <td class="font-mono">{{ formatPolarities(slot) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </aside>
  `,
  styles: [`
    .frontier-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-surface);
      width: 100%;
    }

    .shortcut-tag {
      font-size: 10px;
      font-weight: normal;
      color: #bbbbbb;
    }

    .table-container {
      flex: 1;
      overflow-y: auto;
    }
  `]
})
export class FrontierListComponent {
  readonly boardStore = inject(BoardStore);

  isSelected(slot: BoardSlot): boolean {
    const sel = this.boardStore.selectedSlot();
    return sel !== null && sel.r === slot.r && sel.c === slot.c;
  }

  formatPolarities(slot: BoardSlot): string {
    if (!slot.requiredPolarities) return '—';
    const p = slot.requiredPolarities;
    const code = (val: string) => val[0];
    return `${code(p.north)}-${code(p.east)}-${code(p.south)}-${code(p.west)}`;
  }
}
