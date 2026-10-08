import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../core/state/app-mode.store';
import { ToolbarComponent } from './components/toolbar/toolbar.component';
import { StatusBarComponent } from './components/status-bar/status-bar.component';
import { CommandPaletteComponent } from './components/command-palette/command-palette.component';
import { WorkbenchComponent } from '../workbench/workbench.component';
import { TrayStudioComponent } from '../poster/tray-studio.component';
import { IngestionScannerComponent } from '../scanner/ingestion-scanner.component';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [
    CommonModule,
    ToolbarComponent,
    StatusBarComponent,
    CommandPaletteComponent,
    WorkbenchComponent,
    TrayStudioComponent,
    IngestionScannerComponent
  ],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.css'
})
export class ShellComponent {
  readonly appModeStore = inject(AppModeStore);
}
