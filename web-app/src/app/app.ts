import { Component, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InventoryStore } from './core/stores/inventory.store';
import { BoardStore } from './core/stores/board.store';
import { WasmService } from './core/services/wasm.service';
import { WorkbenchCanvasComponent } from './features/workbench/workbench-canvas.component';
import { PieceTreeComponent } from './features/inventory/piece-tree.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, WorkbenchCanvasComponent, PieceTreeComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  readonly activeMode = signal<'WORKBENCH' | 'CALIBRATION' | 'POSTER'>('WORKBENCH');
  readonly cameraStatus = signal<'STANDBY' | 'STREAMING' | 'OFFLINE'>('STANDBY');
  readonly fps = signal<number>(60);
  readonly rmsErrorMm = signal<number>(0.12);

  constructor(
    public wasm: WasmService,
    public inventoryStore: InventoryStore,
    public boardStore: BoardStore,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      await this.wasm.init();
    } catch {
      // Error handled by WasmService signal
    }
  }

  setMode(mode: 'WORKBENCH' | 'CALIBRATION' | 'POSTER'): void {
    this.activeMode.set(mode);
  }
}
