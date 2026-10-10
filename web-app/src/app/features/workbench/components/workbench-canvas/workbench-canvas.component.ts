import { Component, ElementRef, ViewChild, AfterViewInit, inject, effect } from '@angular/core';
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
  private isViewInit = false;

  constructor() {
    effect(() => {
      // Register reactive dependencies on BoardStore signals
      this.boardStore.selectedSlot();
      this.boardStore.frontierSlots();
      this.boardStore.placedCount();

      if (this.isViewInit) {
        this.renderCanvas();
      }
    });
  }

  ngAfterViewInit(): void {
    this.isViewInit = true;
    this.renderCanvas();
  }

  onCanvasClick(event: MouseEvent): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const cellSize = 22;
    const c = Math.floor(x / cellSize);
    const r = Math.floor(y / cellSize);

    if (r >= 0 && r < this.boardStore.rows && c >= 0 && c < this.boardStore.cols) {
      const frontierSlot = this.boardStore.frontierSlots().find(s => s.r === r && s.c === c);
      if (frontierSlot) {
        this.boardStore.selectSlot(frontierSlot);
      } else {
        const isBorder = (r === 0 || r === this.boardStore.rows - 1 || c === 0 || c === this.boardStore.cols - 1);
        this.boardStore.selectSlot({
          r,
          c,
          isPlaced: isBorder,
        });
      }
    }
  }

  private renderCanvas(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fixed physical grid dimensions (36x28 = 1008 total slots)
    const cols = this.boardStore.cols;
    const rows = this.boardStore.rows;
    const cellSize = 22; // 22px per physical piece slot
    const cssW = cols * cellSize;
    const cssH = rows * cellSize;

    // Hi-DPI Retina scaling
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssW, cssH);

    const frontierSlots = this.boardStore.frontierSlots();
    const selectedSlot = this.boardStore.selectedSlot();

    // Draw grid slots
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isBorder = (r === 0 || r === rows - 1 || c === 0 || c === cols - 1);
        const isSelected = selectedSlot?.r === r && selectedSlot?.c === c;
        const isFrontier = frontierSlots.some(s => s.r === r && s.c === c);

        ctx.strokeStyle = '#d4d4d4';
        ctx.lineWidth = 1;
        ctx.strokeRect(c * cellSize, r * cellSize, cellSize, cellSize);

        if (isBorder) {
          // Border pieces pre-placed
          ctx.fillStyle = '#e5e5e5';
          ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 2, cellSize - 2);
        } else if (isSelected) {
          // Selected frontier slot
          ctx.fillStyle = '#111111';
          ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 2, cellSize - 2);
        } else if (isFrontier) {
          // Active frontier candidate slot
          ctx.fillStyle = '#f3f4f6';
          ctx.fillRect(c * cellSize + 1, r * cellSize + 1, cellSize - 2, cellSize - 2);
          ctx.strokeStyle = '#737373';
          ctx.lineWidth = 1;
          ctx.strokeRect(c * cellSize + 1.5, r * cellSize + 1.5, cellSize - 3, cellSize - 3);
        }
      }
    }

    ctx.restore();
  }
}
