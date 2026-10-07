import { Component, ElementRef, ViewChild, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardStore } from '../../core/state/board.store';

@Component({
  selector: 'app-workbench-canvas',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="canvas-pane-root">
      <div class="inverted-header">
        <span>BOARD CANVAS (34×26 GRID / 1,008 SLOTS)</span>
        <span class="font-mono">SCALE: 1:1 CALIBRATED</span>
      </div>
      <div class="canvas-viewport" #containerRef>
        <canvas #canvasRef class="board-canvas"></canvas>
      </div>
    </div>
  `,
  styles: [`
    .canvas-pane-root {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--bg-surface);
    }

    .canvas-viewport {
      flex: 1;
      width: 100%;
      height: 100%;
      background: #e5e5e5;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .board-canvas {
      background: #ffffff;
      border: 1px solid #111111;
      cursor: crosshair;
    }
  `]
})
export class WorkbenchCanvasComponent implements AfterViewInit {
  @ViewChild('canvasRef') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('containerRef') containerRef!: ElementRef<HTMLDivElement>;

  readonly boardStore = inject(BoardStore);

  ngAfterViewInit(): void {
    this.renderCanvas();
  }

  private renderCanvas(): void {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fixed physical grid dimensions
    const cols = 34;
    const rows = 26;
    const cellSize = 22; // 22px per physical piece slot
    canvas.width = cols * cellSize;
    canvas.height = rows * cellSize;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid slots
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isBorder = (r === 0 || r === rows - 1 || c === 0 || c === cols - 1);
        const isSelected = this.boardStore.selectedSlot()?.r === r && this.boardStore.selectedSlot()?.c === c;

        ctx.strokeStyle = '#d4d4d4';
        ctx.lineWidth = 1;
        ctx.strokeRect(c * cellSize, r * cellSize, cellSize, cellSize);

        if (isBorder) {
          // Border pieces pre-placed
          ctx.fillStyle = '#dfdfdf';
          ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 2, cellSize - 2);
        } else if (isSelected) {
          // Selected frontier slot
          ctx.fillStyle = '#111111';
          ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 2, cellSize - 2);
        }
      }
    }
  }
}
