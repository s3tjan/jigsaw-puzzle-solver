import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../../../core/state/app-mode.store';
import { BoardStore } from '../../../../core/state/board.store';
import { InventoryStore } from '../../../../core/state/inventory.store';
import { PosterStore } from '../../../../core/state/poster.store';
import { CameraService } from '../../../../core/services/camera.service';
import { WasmEngineService } from '../../../../core/services/wasm-engine.service';

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
  readonly posterStore = inject(PosterStore);
  readonly cameraService = inject(CameraService);
  readonly wasmEngine = inject(WasmEngineService);
}
