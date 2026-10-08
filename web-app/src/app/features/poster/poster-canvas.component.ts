import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  effect,
  HostListener
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PosterStore } from '../../core/state/poster.store';
import { PosterSlotFeature, PosterViewMode, TrayId } from '../../core/models/poster.model';

export interface ViewModeConfig {
  id: PosterViewMode;
  label: string;
  hint: string;
  shortcut: string;
}

@Component({
  selector: 'app-poster-canvas',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './poster-canvas.component.html',
  styleUrl: './poster-canvas.component.css'
})
export class PosterCanvasComponent implements AfterViewInit, OnDestroy {
  readonly posterStore = inject(PosterStore);

  readonly viewModes: readonly ViewModeConfig[] = [
    { id: 'TINT', label: 'TINT', hint: 'Color overlays on artwork [1]', shortcut: '1' },
    { id: 'TRAYS', label: 'TRAYS', hint: 'Tray partitions with subdued artwork [2]', shortcut: '2' },
    { id: 'RAW', label: 'RAW', hint: 'Reference poster artwork [3]', shortcut: '3' },
    { id: 'GRADIENT', label: 'GRADIENT', hint: 'Gradient edge density [4]', shortcut: '4' }
  ];

  @ViewChild('viewportRef') private readonly viewportRef!: ElementRef<HTMLDivElement>;
  @ViewChild('canvasRef') private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  // Pan & Zoom transform state
  private scale = 1.0;
  private panX = 0;
  private panY = 0;

  // Interaction tracking (>3px drag threshold)
  private isPointerDown = false;
  private startPointerX = 0;
  private startPointerY = 0;
  private startPanX = 0;
  private startPanY = 0;
  private isDragging = false;
  private resizeObserver?: ResizeObserver;

  constructor() {
    // Re-render when slots, view mode, grid, or solo tray change
    effect(() => {
      this.posterStore.slots();
      this.posterStore.soloTrayId();
      this.posterStore.viewMode();
      this.posterStore.showGrid();
      this.posterStore.selectedSlot();
      this.posterStore.hoveredSlot();
      this.render();
    });
  }

  toggleGrid(): void {
    this.posterStore.toggleGrid();
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (event.key === '1') {
      this.setViewMode('TINT');
    } else if (event.key === '2') {
      this.setViewMode('TRAYS');
    } else if (event.key === '3') {
      this.setViewMode('RAW');
    } else if (event.key === '4') {
      this.setViewMode('GRADIENT');
    } else if (event.key === 'g' || event.key === 'G') {
      this.toggleGrid();
    } else if (event.key === '0') {
      this.resetView();
    }
  }

  ngAfterViewInit(): void {
    this.centerViewport();

    this.resizeObserver = new ResizeObserver(() => {
      this.render();
    });
    this.resizeObserver.observe(this.viewportRef.nativeElement);

    this.render();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  setViewMode(mode: PosterViewMode): void {
    this.posterStore.setViewMode(mode);
  }

  resetView(): void {
    this.scale = 1.0;
    this.centerViewport();
    this.render();
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const zoomFactor = event.deltaY < 0 ? 1.12 : 0.89;
    const newScale = Math.min(3.5, Math.max(0.4, this.scale * zoomFactor));

    const rect = this.viewportRef.nativeElement.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Zoom centered on cursor
    this.panX = mouseX - (mouseX - this.panX) * (newScale / this.scale);
    this.panY = mouseY - (mouseY - this.panY) * (newScale / this.scale);
    this.scale = newScale;

    this.render();
  }

  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return; // Left click only
    this.isPointerDown = true;
    this.isDragging = false;
    this.startPointerX = event.clientX;
    this.startPointerY = event.clientY;
    this.startPanX = this.panX;
    this.startPanY = this.panY;
  }

  onMouseMove(event: MouseEvent): void {
    if (this.isPointerDown) {
      const dx = event.clientX - this.startPointerX;
      const dy = event.clientY - this.startPointerY;
      if (!this.isDragging && Math.hypot(dx, dy) > 3) {
        this.isDragging = true;
      }
      if (this.isDragging) {
        this.panX = this.startPanX + dx;
        this.panY = this.startPanY + dy;
        this.render();
        return;
      }
    }

    // Hit test slot under mouse
    const slot = this.getSlotAtCoordinates(event.clientX, event.clientY);
    if (slot !== this.posterStore.hoveredSlot()) {
      this.posterStore.setHoveredSlot(slot);
    }
  }

  onMouseUp(event: MouseEvent): void {
    if (!this.isPointerDown) return;
    this.isPointerDown = false;

    if (!this.isDragging) {
      // Clean click (less than 3px movement)
      const slot = this.getSlotAtCoordinates(event.clientX, event.clientY);
      if (slot) {
        this.posterStore.selectSlot(slot);
      }
    }
    this.isDragging = false;
  }

  onMouseLeave(): void {
    this.isPointerDown = false;
    this.isDragging = false;
    this.posterStore.setHoveredSlot(null);
  }

  private centerViewport(): void {
    const viewport = this.viewportRef?.nativeElement;
    const posterCanvas = this.posterStore.posterCanvas();
    if (!viewport || !posterCanvas) return;

    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const pw = posterCanvas.width;
    const ph = posterCanvas.height;

    // Fit within viewport with 16px margin
    const scaleX = (vw - 32) / pw;
    const scaleY = (vh - 32) / ph;
    this.scale = Math.min(1.0, Math.min(scaleX, scaleY));

    this.panX = Math.round((vw - pw * this.scale) / 2);
    this.panY = Math.round((vh - ph * this.scale) / 2);
  }

  private getSlotAtCoordinates(clientX: number, clientY: number): PosterSlotFeature | null {
    const canvas = this.canvasRef?.nativeElement;
    const posterCanvas = this.posterStore.posterCanvas();
    if (!canvas || !posterCanvas) return null;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    // Map screen pixel back to poster space
    const posterX = (x - this.panX) / this.scale;
    const posterY = (y - this.panY) / this.scale;

    if (posterX < 0 || posterX >= posterCanvas.width || posterY < 0 || posterY >= posterCanvas.height) {
      return null;
    }

    const colW = posterCanvas.width / this.posterStore.cols;
    const rowH = posterCanvas.height / this.posterStore.rows;

    const c = Math.floor(posterX / colW);
    const r = Math.floor(posterY / rowH);

    return this.posterStore.slots().find(s => s.r === r && s.c === c) || null;
  }

  private render(): void {
    const canvas = this.canvasRef?.nativeElement;
    const viewport = this.viewportRef?.nativeElement;
    const sourceCanvas = this.posterStore.posterCanvas();
    if (!canvas || !viewport || !sourceCanvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }

    // 1. Clear background
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, vw, vh);

    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    const pw = sourceCanvas.width;
    const ph = sourceCanvas.height;
    const cols = this.posterStore.cols;
    const rows = this.posterStore.rows;
    const slotW = pw / cols;
    const slotH = ph / rows;

    const mode = this.posterStore.viewMode();
    const soloTray = this.posterStore.soloTrayId();
    const selected = this.posterStore.selectedSlot();
    const hovered = this.posterStore.hoveredSlot();
    const trayMap = this.posterStore.trayMap();

    // 2. Draw poster image or gradient
    if (mode === 'GRADIENT') {
      ctx.fillStyle = '#111111';
      ctx.fillRect(0, 0, pw, ph);
    } else if (mode === 'TRAYS') {
      // Background poster is heavily muted/subdued watermark so tray boundaries dominate
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(sourceCanvas, 0, 0);
    }

    // 3. Draw Slot Tints & Grid Lines
    const slots = this.posterStore.slots();
    const showGrid = this.posterStore.showGrid();

    for (const slot of slots) {
      const sx = slot.c * slotW;
      const sy = slot.r * slotH;
      const isSoloMatch = soloTray === null || slot.trayId === soloTray;
      const isSelected = selected?.r === slot.r && selected?.c === slot.c;
      const isHovered = hovered?.r === slot.r && hovered?.c === slot.c;

      if (mode === 'GRADIENT') {
        // High-contrast gradient density visualization
        const intensity = Math.round(slot.gradient * 255);
        ctx.fillStyle = `rgb(${intensity}, ${intensity}, ${intensity})`;
        ctx.globalAlpha = 1.0;
        ctx.fillRect(sx, sy, slotW, slotH);
      } else if (mode === 'TRAYS') {
        // Raw Tray map view: poster is muted, trays are prominent and clear
        if (slot.isBorder) {
          ctx.fillStyle = '#4b5563';
          ctx.globalAlpha = 0.85;
          ctx.fillRect(sx, sy, slotW, slotH);
        } else {
          const tray = slot.trayId > 0 ? trayMap.get(slot.trayId as TrayId) : null;
          const color = tray ? tray.color : '#6b7280';

          if (soloTray !== null) {
            if (isSoloMatch) {
              ctx.fillStyle = color;
              ctx.globalAlpha = 0.90;
              ctx.fillRect(sx, sy, slotW, slotH);
            } else {
              ctx.fillStyle = '#e5e7eb';
              ctx.globalAlpha = 0.60;
              ctx.fillRect(sx, sy, slotW, slotH);
            }
          } else {
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.85;
            ctx.fillRect(sx, sy, slotW, slotH);
          }
        }
      } else if (mode === 'TINT') {
        if (slot.isBorder) {
          // Pre-anchored border piece (124 pieces)
          ctx.fillStyle = '#6b7280';
          ctx.globalAlpha = 0.25;
          ctx.fillRect(sx, sy, slotW, slotH);
        } else {
          const tray = slot.trayId > 0 ? trayMap.get(slot.trayId as TrayId) : null;
          const color = tray ? tray.color : '#6b7280';

          if (soloTray !== null) {
            if (isSoloMatch) {
              ctx.fillStyle = color;
              ctx.globalAlpha = 0.55;
              ctx.fillRect(sx, sy, slotW, slotH);
            } else {
              // Mute other slots
              ctx.fillStyle = '#ffffff';
              ctx.globalAlpha = 0.65;
              ctx.fillRect(sx, sy, slotW, slotH);
            }
          } else {
            // Standard tint overlay (TRY-06)
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.35;
            ctx.fillRect(sx, sy, slotW, slotH);
          }
        }
      }

      ctx.globalAlpha = 1.0;

      // 4. Grid Rules (1px solid boundaries, toggleable)
      if (showGrid) {
        ctx.strokeStyle = mode === 'TRAYS' ? 'rgba(255, 255, 255, 0.45)' : '#d4d4d4';
        ctx.lineWidth = 1;
        ctx.strokeRect(sx, sy, slotW, slotH);
      }

      // 5. Selected or Hovered Slot Accent (always visible)
      if (isSelected) {
        ctx.strokeStyle = '#111111';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx + 1, sy + 1, slotW - 2, slotH - 2);
      } else if (isHovered) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx + 0.5, sy + 0.5, slotW - 1, slotH - 1);
      }
    }

    ctx.restore();
  }
}
