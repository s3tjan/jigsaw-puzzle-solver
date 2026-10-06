import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BoardStore } from '../../core/stores/board.store';
import { InventoryStore } from '../../core/stores/inventory.store';

@Component({
  selector: 'app-workbench-canvas',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="workbench-viewport" #container (wheel)="onWheel($event)" (mousedown)="onMouseDown($event)" (mousemove)="onMouseMove($event)" (mouseup)="onMouseUp($event)">
      <canvas #canvas class="board-canvas"></canvas>
      <div class="canvas-hud">
        <span class="hud-item">ZOOM: {{ (scale * 100).toFixed(0) }}%</span>
        <span class="hud-item">OFFSET: {{ panX.toFixed(0) }}, {{ panY.toFixed(0) }}</span>
        @if (boardStore.hoveredSlot(); as slot) {
          <span class="hud-item hud-active">SLOT: R{{ slot.row }} C{{ slot.col }}</span>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
      overflow: hidden;
      background: #e5e5e5;
    }
    .workbench-viewport {
      width: 100%;
      height: 100%;
      position: relative;
      cursor: crosshair;
    }
    .board-canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    .canvas-hud {
      position: absolute;
      bottom: 8px;
      left: 8px;
      display: flex;
      gap: 8px;
      background: #ffffff;
      border: 1px solid #d4d4d4;
      padding: 2px 6px;
      font-size: 11px;
      font-family: var(--font-mono);
      user-select: none;
      pointer-events: none;
    }
    .hud-item {
      color: #525252;
    }
    .hud-active {
      color: #111111;
      font-weight: 600;
    }
  `],
})
export class WorkbenchCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  scale = 1.0;
  panX = 60;
  panY = 40;

  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragDistance = 0;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    public boardStore: BoardStore,
    public inventoryStore: InventoryStore,
  ) {}

  ngAfterViewInit(): void {
    this.setupResizeObserver();
    this.render();
  }

  ngOnDestroy(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
  }

  private setupResizeObserver(): void {
    const container = this.containerRef.nativeElement;
    const canvas = this.canvasRef.nativeElement;
    this.resizeObserver = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      this.render();
    });
    this.resizeObserver.observe(container);
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.min(Math.max(this.scale * zoomFactor, 0.2), 5.0);

    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    this.panX = mouseX - (mouseX - this.panX) * (newScale / this.scale);
    this.panY = mouseY - (mouseY - this.panY) * (newScale / this.scale);
    this.scale = newScale;

    this.render();
  }

  onMouseDown(event: MouseEvent): void {
    if (event.button === 0 || event.button === 1) {
      this.isDragging = true;
      this.dragStartX = event.clientX - this.panX;
      this.dragStartY = event.clientY - this.panY;
      this.dragDistance = 0;
    }
  }

  onMouseMove(event: MouseEvent): void {
    if (this.isDragging) {
      const currentX = event.clientX - this.dragStartX;
      const currentY = event.clientY - this.dragStartY;
      const dx = currentX - this.panX;
      const dy = currentY - this.panY;
      this.dragDistance += Math.hypot(dx, dy);
      this.panX = currentX;
      this.panY = currentY;
      this.render();
    } else {
      this.updateHoveredSlot(event);
    }
  }

  onMouseUp(event: MouseEvent): void {
    if (this.isDragging) {
      this.isDragging = false;
      // Pan/Zoom isolation rule: Ignore click if drag was > 3px
      if (this.dragDistance <= 3) {
        this.handleSlotClick(event);
      }
    }
  }

  private updateHoveredSlot(event: MouseEvent): void {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    const boardX = (canvasX - this.panX) / this.scale;
    const boardY = (canvasY - this.panY) / this.scale;

    const cellSize = 32;
    const col = Math.floor(boardX / cellSize);
    const row = Math.floor(boardY / cellSize);

    const dims = this.boardStore.dimensions();
    if (row >= 0 && row < dims.rows && col >= 0 && col < dims.cols) {
      this.boardStore.setHoveredSlot(row, col);
    } else {
      this.boardStore.clearHoveredSlot();
    }
    this.render();
  }

  private handleSlotClick(event: MouseEvent): void {
    const slot = this.boardStore.hoveredSlot();
    const selectedPiece = this.inventoryStore.selectedPiece();
    if (slot && selectedPiece) {
      this.boardStore.placePiece(slot.row, slot.col, selectedPiece.id, 0);
      this.inventoryStore.updatePieceStatus(selectedPiece.id, 'Placed', { row: slot.row, col: slot.col, rotation: 0 });
      this.render();
    }
  }

  render(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    const dims = this.boardStore.dimensions();
    const cellSize = 32;
    const boardWidth = dims.cols * cellSize;
    const boardHeight = dims.rows * cellSize;

    // Board Surface
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, boardWidth, boardHeight);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1 / this.scale;
    ctx.strokeRect(0, 0, boardWidth, boardHeight);

    // Grid lines (1px crisp)
    ctx.strokeStyle = '#e5e5e5';
    ctx.lineWidth = 1 / this.scale;
    ctx.beginPath();
    for (let c = 1; c < dims.cols; c++) {
      const x = c * cellSize;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, boardHeight);
    }
    for (let r = 1; r < dims.rows; r++) {
      const y = r * cellSize;
      ctx.moveTo(0, y);
      ctx.lineTo(boardWidth, y);
    }
    ctx.stroke();

    // Placed slots
    const placed = this.boardStore.placedSlots();
    ctx.fillStyle = '#111111';
    for (const [key, item] of placed) {
      const x = item.col * cellSize;
      const y = item.row * cellSize;
      ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
    }

    // Hover Highlight
    const hovered = this.boardStore.hoveredSlot();
    if (hovered) {
      ctx.fillStyle = 'rgba(21, 128, 61, 0.25)'; // Functional status active tint
      ctx.fillRect(hovered.col * cellSize, hovered.row * cellSize, cellSize, cellSize);
      ctx.strokeStyle = '#15803d';
      ctx.lineWidth = 1 / this.scale;
      ctx.strokeRect(hovered.col * cellSize, hovered.row * cellSize, cellSize, cellSize);
    }

    ctx.restore();
  }
}
