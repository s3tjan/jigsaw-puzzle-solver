import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InventoryStore } from '../../core/stores/inventory.store';
import { PieceModel } from '../../core/models/piece.model';

@Component({
  selector: 'app-piece-tree',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="filter-strip">
      <button class="filter-btn" [class.active]="filter() === 'ALL'" (click)="setFilter('ALL')">All ({{ inventoryStore.totalCount() }})</button>
      <button class="filter-btn" [class.active]="filter() === 'TRAY'" (click)="setFilter('TRAY')">Unplaced ({{ inventoryStore.inTrayCount() }})</button>
      <button class="filter-btn" [class.active]="filter() === 'PLACED'" (click)="setFilter('PLACED')">Placed ({{ inventoryStore.placedCount() }})</button>
    </div>

    <div class="piece-list">
      @if (filteredPieces().length === 0) {
        <div class="empty-token">No Pieces Yet</div>
      } @else {
        <table class="piece-table">
          <thead>
            <tr>
              <th style="width: 32px;">#</th>
              <th>Type</th>
              <th>Edges</th>
              <th style="text-align: right;">Status</th>
            </tr>
          </thead>
          <tbody>
            @for (piece of filteredPieces(); track piece.id) {
              <tr
                [class.selected]="inventoryStore.selectedPieceId() === piece.id"
                (click)="inventoryStore.selectPiece(piece.id)">
                <td class="font-mono">#{{ piece.piece_number }}</td>
                <td>{{ piece.classification }}</td>
                <td class="font-mono">{{ piece.tab_count }}/{{ piece.hole_count }}/{{ piece.flat_count }}</td>
                <td style="text-align: right;" class="font-mono">{{ piece.status }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    }
    .filter-strip {
      display: flex;
      border-bottom: 1px solid var(--border-rule);
      background: var(--bg-workspace);
    }
    .filter-btn {
      flex: 1;
      height: 24px;
      padding: 0 4px;
      font-size: 11px;
      font-weight: 500;
      border: none;
      border-right: 1px solid var(--border-rule);
      background: transparent;
      cursor: pointer;
    }
    .filter-btn:last-child {
      border-right: none;
    }
    .filter-btn.active {
      background: var(--bg-panel);
      font-weight: 700;
      border-bottom: 1px solid var(--bg-panel);
    }
    .piece-list {
      flex: 1;
      overflow-y: auto;
    }
    .piece-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .piece-table th {
      background: var(--bg-workspace);
      border-bottom: 1px solid var(--border-rule);
      padding: 3px 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      text-align: left;
      color: var(--text-muted);
    }
    .piece-table tr {
      height: 26px;
      border-bottom: 1px solid var(--border-rule);
      cursor: pointer;
    }
    .piece-table tr:hover {
      background: var(--bg-hover);
    }
    .piece-table tr.selected {
      background: var(--bg-selected);
      color: var(--text-selected);
    }
    .piece-table tr.selected td {
      color: var(--text-selected);
    }
    .piece-table td {
      padding: 2px 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .empty-token {
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
      margin-top: 16px;
      text-transform: uppercase;
    }
  `],
})
export class PieceTreeComponent {
  filter = signal<'ALL' | 'TRAY' | 'PLACED'>('ALL');

  constructor(public inventoryStore: InventoryStore) {}

  setFilter(val: 'ALL' | 'TRAY' | 'PLACED'): void {
    this.filter.set(val);
  }

  filteredPieces(): PieceModel[] {
    const list = this.inventoryStore.pieces();
    const mode = this.filter();
    if (mode === 'TRAY') return list.filter(p => p.status === 'InTray');
    if (mode === 'PLACED') return list.filter(p => p.status === 'Placed');
    return list;
  }
}
import { signal } from '@angular/core';
