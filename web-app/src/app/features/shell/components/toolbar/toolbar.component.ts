import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../../../core/state/app-mode.store';
import { AppMode } from '../../../../core/models/operator.model';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.css'
})
export class ToolbarComponent {
  readonly appModeStore = inject(AppModeStore);

  setMode(mode: AppMode): void {
    this.appModeStore.setMode(mode);
  }

  openCommandPalette(): void {
    this.appModeStore.openCommandPalette();
  }
}
