import {
  Component,
  ElementRef,
  ViewChild,
  OnInit,
  OnDestroy,
  inject,
  signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../core/state/app-mode.store';
import { CameraService } from '../../core/services/camera.service';
import { WasmEngineService } from '../../core/services/wasm-engine.service';

@Component({
  selector: 'app-optics-calibration',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './optics-calibration.component.html',
  styleUrl: './optics-calibration.component.css'
})
export class OpticsCalibrationComponent implements OnInit, OnDestroy {
  readonly appModeStore = inject(AppModeStore);
  readonly cameraService = inject(CameraService);
  readonly wasmEngine = inject(WasmEngineService);

  @ViewChild('videoRef') videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('overlayCanvas') overlayCanvas!: ElementRef<HTMLCanvasElement>;

  // Optical Calibration & Metric Grounding State (OPT-02 & OPT-03)
  // [C1: TL, C2: TR, C3: BR, C4: BL] in camera pixel coordinates
  readonly corners = signal<[ { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number } ]>([
    { x: 120, y: 80 },
    { x: 520, y: 80 },
    { x: 520, y: 400 },
    { x: 120, y: 400 }
  ]);
  readonly lensK1 = signal<number>(0.0);
  readonly sensitivity = signal<number>(25.0);
  readonly focusMtf = signal<number>(0.0);
  readonly statusMessage = signal<string | null>(null);

  private draggingIdx: number | null = null;
  private animFrameId: number | null = null;
  private focusIntervalId: any = null;

  async ngOnInit(): Promise<void> {
    this.loadCalibration();
    await this.cameraService.refreshDevices();
    await this.cameraService.startStream(this.videoRef?.nativeElement);
    this.startOverlayLoop();

    // Periodic focus MTF measurement (every 500ms)
    this.focusIntervalId = setInterval(() => {
      this.measureFocus();
    }, 500);
  }

  ngOnDestroy(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    if (this.focusIntervalId) clearInterval(this.focusIntervalId);
  }

  private loadCalibration(): void {
    try {
      const savedCorners = localStorage.getItem('jigsaw_calibration_corners_v3');
      if (savedCorners) {
        const parsed = JSON.parse(savedCorners);
        if (Array.isArray(parsed) && parsed.length === 4) {
          this.corners.set(parsed as any);
        }
      }
      const savedK1 = localStorage.getItem('jigsaw_k1');
      if (savedK1) {
        this.lensK1.set(parseFloat(savedK1) || 0.0);
      }
      const savedSens = localStorage.getItem('jigsaw_sensitivity');
      if (savedSens) {
        this.sensitivity.set(parseFloat(savedSens) || 25.0);
      }
    } catch { }
  }

  saveCalibration(): void {
    try {
      localStorage.setItem('jigsaw_calibration_corners_v3', JSON.stringify(this.corners()));
      localStorage.setItem('jigsaw_k1', this.lensK1().toString());
      localStorage.setItem('jigsaw_sensitivity', this.sensitivity().toString());
    } catch { }
  }

  setLensK1(val: number): void {
    this.lensK1.set(Number(val.toFixed(2)));
    this.saveCalibration();
  }

  setSensitivity(val: number): void {
    this.sensitivity.set(Number(val));
    this.saveCalibration();
  }

  resetCorners(): void {
    const video = this.videoRef?.nativeElement;
    const w = video?.videoWidth || 640;
    const h = video?.videoHeight || 480;
    const marginX = w * 0.15;
    const marginY = h * 0.15;
    this.corners.set([
      { x: marginX, y: marginY },
      { x: w - marginX, y: marginY },
      { x: w - marginX, y: h - marginY },
      { x: marginX, y: h - marginY }
    ]);
    this.saveCalibration();
    this.statusMessage.set('CORNERS RESET TO DEFAULTS');
  }

  snapAllCorners(): void {
    const video = this.videoRef?.nativeElement;
    if (!video || !this.cameraService.isStreaming()) return;
    const canvas = this.cameraService.captureFrame(video);
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgba = new Uint8Array(imgData.data.buffer);

    const cur = this.corners();
    let snappedCount = 0;
    const updated = cur.map(c => {
      const snapped = this.wasmEngine.snapFiducialCorner(rgba, canvas.width, canvas.height, c.x, c.y, 40);
      if (snapped) {
        snappedCount++;
        return { x: snapped[0], y: snapped[1] };
      }
      return c;
    }) as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];

    this.corners.set(updated);
    this.saveCalibration();
    this.statusMessage.set(`SNAPPED ${snappedCount}/4 FIDUCIAL BULLSEYES`);
  }

  private measureFocus(): void {
    const video = this.videoRef?.nativeElement;
    if (!video || !this.cameraService.isStreaming()) return;
    const canvas = this.cameraService.captureFrame(video);
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const rgba = new Uint8Array(imgData.data.buffer);

    const pts = this.corners();
    const corners: [number, number, number, number, number, number, number, number] = [
      pts[0].x, pts[0].y,
      pts[1].x, pts[1].y,
      pts[2].x, pts[2].y,
      pts[3].x, pts[3].y
    ];

    const score = this.wasmEngine.measureStageFocus(rgba, canvas.width, canvas.height, corners);
    this.focusMtf.set(Number(score.toFixed(1)));
  }

  async retryCamera(): Promise<void> {
    await this.cameraService.startStream(this.videoRef?.nativeElement);
  }

  handlePointerDown(event: PointerEvent): void {
    const canvas = this.overlayCanvas?.nativeElement;
    if (!canvas) return;

    const pt = this.getCanvasCoords(event, canvas);
    const pts = this.corners();
    const HIT_RADIUS = 32;

    for (let i = 0; i < 4; i++) {
      if (Math.hypot(pts[i].x - pt.x, pts[i].y - pt.y) <= HIT_RADIUS) {
        this.draggingIdx = i;
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        return;
      }
    }
  }

  handlePointerMove(event: PointerEvent): void {
    if (this.draggingIdx === null) return;
    const canvas = this.overlayCanvas?.nativeElement;
    if (!canvas) return;

    const pt = this.getCanvasCoords(event, canvas);
    const cur = [...this.corners()] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    cur[this.draggingIdx] = pt;
    this.corners.set(cur);
  }

  handlePointerUp(event: PointerEvent): void {
    if (this.draggingIdx !== null) {
      const idx = this.draggingIdx;
      this.draggingIdx = null;
      try {
        (event.target as HTMLElement).releasePointerCapture(event.pointerId);
      } catch { }

      // Auto sub-pixel snap on release
      const video = this.videoRef?.nativeElement;
      if (video && this.cameraService.isStreaming()) {
        const frameCanvas = this.cameraService.captureFrame(video);
        if (frameCanvas) {
          const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            const imgData = ctx.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
            const rgba = new Uint8Array(imgData.data.buffer);
            const curPt = this.corners()[idx];
            const snapped = this.wasmEngine.snapFiducialCorner(rgba, frameCanvas.width, frameCanvas.height, curPt.x, curPt.y, 32);
            if (snapped) {
              const cur = [...this.corners()] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
              cur[idx] = { x: snapped[0], y: snapped[1] };
              this.corners.set(cur);
            }
          }
        }
      }

      this.saveCalibration();
    }
  }

  private getCanvasCoords(event: PointerEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY
    };
  }

  private startOverlayLoop(): void {
    const render = () => {
      this.drawOverlay();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  private drawOverlay(): void {
    const overlay = this.overlayCanvas?.nativeElement;
    const video = this.videoRef?.nativeElement;
    if (!overlay || !video || !this.cameraService.isStreaming()) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw === 0 || vh === 0) return;

    if (overlay.width !== vw || overlay.height !== vh) {
      overlay.width = vw;
      overlay.height = vh;
    }

    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, vw, vh);

    const pts = this.corners();
    const k1 = this.lensK1();

    // Radial distortion mapping helpers so lens K1 visibly curves the quad boundary
    const distortPt = (x: number, y: number): { x: number; y: number } => {
      if (Math.abs(k1) <= 1e-4) return { x, y };
      const cx = vw * 0.5;
      const cy = vh * 0.5;
      const diag = Math.hypot(cx, cy) || 1.0;
      const normX = (x - cx) / diag;
      const normY = (y - cy) / diag;
      const factor = 1.0 + k1 * (normX * normX + normY * normY);
      return {
        x: cx + normX * factor * diag,
        y: cy + normY * factor * diag
      };
    };

    const undistortPt = (x: number, y: number): { x: number; y: number } => {
      if (Math.abs(k1) <= 1e-4) return { x, y };
      const cx = vw * 0.5;
      const cy = vh * 0.5;
      const diag = Math.hypot(cx, cy) || 1.0;
      const distX = (x - cx) / diag;
      const distY = (y - cy) / diag;
      const rDist = Math.hypot(distX, distY);
      if (rDist < 1e-6) return { x, y };
      let rUn = rDist;
      for (let iter = 0; iter < 5; iter++) {
        const f = rUn * (1.0 + k1 * rUn * rUn) - rDist;
        const df = 1.0 + 3.0 * k1 * rUn * rUn;
        if (Math.abs(df) > 1e-6) rUn -= f / df;
      }
      const scale = Math.max(0.1, Math.min(3.0, rUn / rDist));
      return {
        x: cx + distX * scale * diag,
        y: cy + distY * scale * diag
      };
    };

    // 1. Draw boundary quad connecting the 4 corners (curved according to K1 distortion)
    ctx.beginPath();
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1.5;

    const SAMPLES = 24;
    for (let side = 0; side < 4; side++) {
      const p1 = undistortPt(pts[side].x, pts[side].y);
      const p2 = undistortPt(pts[(side + 1) % 4].x, pts[(side + 1) % 4].y);
      for (let s = 0; s <= SAMPLES; s++) {
        const t = s / SAMPLES;
        const px = p1.x + (p2.x - p1.x) * t;
        const py = p1.y + (p2.y - p1.y) * t;
        const dPt = distortPt(px, py);
        if (side === 0 && s === 0) ctx.moveTo(dPt.x, dPt.y);
        else ctx.lineTo(dPt.x, dPt.y);
      }
    }
    ctx.closePath();
    ctx.stroke();

    // 2. Optical Center Crosshair (1px crisp lines)
    const cx = vw / 2;
    const cy = vh / 2;
    ctx.beginPath();
    ctx.strokeStyle = '#525252';
    ctx.lineWidth = 1.0;
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.moveTo(cx, cy - 16);
    ctx.lineTo(cx, cy + 16);
    ctx.stroke();

    // 3. Draw 4 Fiducial Corner Reticles (Square industrial brackets, 12px monospace text)
    const labels = ['C1 [TL]', 'C2 [TR]', 'C3 [BR]', 'C4 [BL]'];
    pts.forEach((pt, i) => {
      const isDragging = i === this.draggingIdx;
      const strokeColor = isDragging ? '#b45309' : '#111111';
      const fillColor = isDragging ? '#b45309' : '#111111';

      // Square reticle box (16x16 square, 0 radius)
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = isDragging ? 2.0 : 1.0;
      ctx.strokeRect(pt.x - 8, pt.y - 8, 16, 16);

      // Center cross
      ctx.beginPath();
      ctx.moveTo(pt.x - 14, pt.y);
      ctx.lineTo(pt.x + 14, pt.y);
      ctx.moveTo(pt.x, pt.y - 14);
      ctx.lineTo(pt.x, pt.y + 14);
      ctx.stroke();

      // Industrial Label Tag (opaque inverted tag)
      ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
      const labelText = labels[i];
      const textMetrics = ctx.measureText(labelText);
      const tagW = textMetrics.width + 6;
      const tagH = 14;
      const tagX = pt.x + 12;
      const tagY = pt.y - 16;

      ctx.fillStyle = fillColor;
      ctx.fillRect(tagX, tagY, tagW, tagH);

      ctx.fillStyle = '#f5f5f5';
      ctx.fillText(labelText, tagX + 3, tagY + 11);
    });
  }
}
