import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../../../core/state/app-mode.store';
import { BoardStore } from '../../../../core/state/board.store';
import { InventoryStore } from '../../../../core/state/inventory.store';

@Component({
  selector: 'app-status-bar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './status-bar.component.html',
  styleUrl: './status-bar.component.css'
})
export class StatusBarComponent {
  readonly appModeStore = inject(AppModeStore);
  readonly boardStore = inject(BoardStore);
  readonly inventoryStore = inject(InventoryStore);
}
