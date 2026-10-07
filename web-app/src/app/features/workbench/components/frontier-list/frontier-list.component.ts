import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardStore } from '../../../../core/state/board.store';
import { BoardSlot } from '../../../../core/models/operator.model';

@Component({
  selector: 'app-frontier-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './frontier-list.component.html',
  styleUrl: './frontier-list.component.css'
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
