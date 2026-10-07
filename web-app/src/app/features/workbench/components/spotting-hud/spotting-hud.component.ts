import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardStore } from '../../../../core/state/board.store';

@Component({
  selector: 'app-spotting-hud',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './spotting-hud.component.html',
  styleUrl: './spotting-hud.component.css'
})
export class SpottingHudComponent {
  readonly boardStore = inject(BoardStore);
}
