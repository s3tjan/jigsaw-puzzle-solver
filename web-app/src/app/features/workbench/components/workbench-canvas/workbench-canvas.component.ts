import { Component, ElementRef, ViewChild, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardStore } from '../../../../core/state/board.store';

@Component({
  selector: 'app-workbench-canvas',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './workbench-canvas.component.html',
  styleUrl: './workbench-canvas.component.css'
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

    // Fixed physical grid dimensions (36x28 = 1008 total slots)
    const cols = this.boardStore.cols;
    const rows = this.boardStore.rows;
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
