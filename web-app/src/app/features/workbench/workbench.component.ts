import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../core/state/app-mode.store';
import { FrontierListComponent } from './components/frontier-list/frontier-list.component';
import { WorkbenchCanvasComponent } from './components/workbench-canvas/workbench-canvas.component';
import { SpottingHudComponent } from './components/spotting-hud/spotting-hud.component';

@Component({
  selector: 'app-workbench',
  standalone: true,
  imports: [
    CommonModule,
    FrontierListComponent,
    WorkbenchCanvasComponent,
    SpottingHudComponent
  ],
  templateUrl: './workbench.component.html',
  styleUrl: './workbench.component.css'
})
export class WorkbenchComponent {
  readonly appModeStore = inject(AppModeStore);
}
