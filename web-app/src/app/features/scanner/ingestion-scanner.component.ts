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
import { StorageService, StoredPiece } from '../../core/services/storage.service';
import { InventoryStore } from '../../core/state/inventory.store';
import { PosterStore } from '../../core/state/poster.store';
import { WasmEngineService, IngestedPiecePayload } from '../../core/services/wasm-engine.service';
import { TrayId } from '../../core/models/poster.model';

@Component({
  selector: 'app-ingestion-scanner',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ingestion-scanner.component.html',
  styleUrl: './ingestion-scanner.component.css'
})
export class IngestionScannerComponent implements OnInit, OnDestroy {
  readonly appModeStore = inject(AppModeStore);
  readonly cameraService = inject(CameraService);
  readonly storageService = inject(StorageService);
  readonly inventoryStore = inject(InventoryStore);
  readonly posterStore = inject(PosterStore);
  readonly wasmEngine = inject(WasmEngineService);

  @ViewChild('videoRef') videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('stageCanvas') stageCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('stageOverlayCanvas') stageOverlayCanvas!: ElementRef<HTMLCanvasElement>;

  // Peripheral color flash state for eyes-free sorting feedback (TRY-05 & ING-03)
  readonly activeFlashColor = signal<string | null>(null);
  readonly flashMessage = signal<string | null>(null);

  // Ingestion stats & error feedback
  readonly lastPiece = signal<StoredPiece | null>(null);
  readonly lastIngestionPayload = signal<IngestedPiecePayload | null>(null);
  readonly isProcessing = signal<boolean>(false);
  readonly scanStatusMessage = signal<string | null>(null);
  private flashTimeout: any = null;
  private animFrameId: number | null = null;

  // Calibrated homography & lens distortion loaded from shared storage
  readonly corners = signal<[ { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number } ]>([
    { x: 120, y: 80 },
    { x: 520, y: 80 },
    { x: 520, y: 400 },
    { x: 120, y: 400 }
  ]);
  readonly lensK1 = signal<number>(0.0);
  readonly sensitivity = signal<number>(25.0);

  async ngOnInit(): Promise<void> {
    this.loadCalibration();
    await this.cameraService.refreshDevices();
    await this.cameraService.startStream(this.videoRef?.nativeElement);
    this.startStageRenderingLoop();
  }

  ngOnDestroy(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    if (this.flashTimeout) clearTimeout(this.flashTimeout);
  }

  loadCalibration(): void {
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

  async retryCamera(): Promise<void> {
    await this.cameraService.startStream(this.videoRef?.nativeElement);
  }

  /**
   * Continuous dewarping render loop: displays the rectified 384x384 (96mm) stage arena
   */
  private startStageRenderingLoop(): void {
    const render = () => {
      this.renderStageFrame();
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  private renderStageFrame(): void {
    const video = this.videoRef?.nativeElement;
    const canvas = this.stageCanvas?.nativeElement;
    if (!video || !canvas || !this.cameraService.isStreaming()) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    const frameCanvas = this.cameraService.captureFrame(video);
    if (!frameCanvas) return;

    const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
    const rgba = new Uint8Array(imgData.data.buffer);

    const pts = this.corners();
    const cornerCoords: [number, number, number, number, number, number, number, number] = [
      pts[0].x, pts[0].y,
      pts[1].x, pts[1].y,
      pts[2].x, pts[2].y,
      pts[3].x, pts[3].y
    ];

    const dewarped = this.wasmEngine.dewarpQuad(
      rgba,
      frameCanvas.width,
      frameCanvas.height,
      cornerCoords,
      384,
      384,
      this.lensK1()
    );

    if (dewarped) {
      const stageCtx = canvas.getContext('2d');
      if (stageCtx) {
        const stageImgData = stageCtx.createImageData(384, 384);
        stageImgData.data.set(dewarped);
        stageCtx.putImageData(stageImgData, 0, 0);
      }
    }

    this.drawStageOverlay();
  }

  private drawStageOverlay(): void {
    const overlay = this.stageOverlayCanvas?.nativeElement;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 384, 384);

    // 1. Physical 96mm x 96mm boundary frame (1px solid crisp rule)
    ctx.strokeStyle = '#d4d4d4';
    ctx.lineWidth = 1.0;
    ctx.strokeRect(0.5, 0.5, 383, 383);

    // 2. Center stage reticle (16px crosshair)
    ctx.strokeStyle = '#525252';
    ctx.beginPath();
    ctx.moveTo(192 - 12, 192);
    ctx.lineTo(192 + 12, 192);
    ctx.moveTo(192, 192 - 12);
    ctx.lineTo(192, 192 + 12);
    ctx.stroke();

    // 3. Render latest piece contour & corners if available
    const payload = this.lastIngestionPayload();
    if (payload && payload.success && payload.contourPoints.length >= 6) {
      // Draw detected piece boundary (sharp 1px dark line)
      ctx.beginPath();
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 1.5;
      const pts = payload.contourPoints;
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) {
        ctx.lineTo(pts[i], pts[i + 1]);
      }
      ctx.closePath();
      ctx.stroke();

      // Draw 4 physical piece corners
      if (payload.corners.length >= 8) {
        ctx.strokeStyle = '#b45309';
        ctx.lineWidth = 1.0;
        for (let i = 0; i < 8; i += 2) {
          const cx = payload.corners[i];
          const cy = payload.corners[i + 1];
          ctx.strokeRect(cx - 3, cy - 3, 6, 6);
        }
      }
    }
  }

  /**
   * Continuous mat piece ingestion via cv-engine WASM bridge (Task ING-02B)
   * Triggered by Space key or #scan-drop-btn click
   */
  async triggerScan(): Promise<void> {
    if (this.isProcessing()) return;

    const video = this.videoRef?.nativeElement;
    if (!video || !this.cameraService.isStreaming()) {
      this.scanStatusMessage.set('CAMERA STREAM NOT ACTIVE');
      return;
    }

    this.isProcessing.set(true);
    this.scanStatusMessage.set('SEGMENTING PIECE ON STAGE...');

    const frameCanvas = this.cameraService.captureFrame(video);
    if (!frameCanvas) {
      this.isProcessing.set(false);
      this.scanStatusMessage.set('FAILED TO CAPTURE FRAME');
      return;
    }

    const pts = this.corners();
    const cornerCoords: [number, number, number, number, number, number, number, number] = [
      pts[0].x, pts[0].y,
      pts[1].x, pts[1].y,
      pts[2].x, pts[2].y,
      pts[3].x, pts[3].y
    ];

    const centroids = this.posterStore.activeCentroids();
    const wasmResult = this.wasmEngine.ingestMatPiece(
      frameCanvas,
      cornerCoords,
      centroids,
      { wColor: 0.7, wTexture: 0.2 },
      this.sensitivity(),
      this.lensK1()
    );

    if (!wasmResult || !wasmResult.success) {
      this.scanStatusMessage.set(wasmResult?.error || 'STAGE EMPTY OR OBSTRUCTED');
      this.isProcessing.set(false);
      return;
    }

    this.lastIngestionPayload.set(wasmResult);
    this.scanStatusMessage.set(null);

    // Generate new piece ID based on current total ingested
    const pieceId = this.inventoryStore.totalIngested() + 1;
    const targetTrayId = (wasmResult.trayId > 0 ? wasmResult.trayId : 0) as TrayId | 0;
    const polarities = wasmResult.polarities;
    const tabWidthMm = wasmResult.tabWidthMm;
    const confidence = wasmResult.confidence;

    // Convert contour flat list to [x, y] pairs
    const contourPairs: [number, number][] = [];
    for (let i = 0; i < wasmResult.contourPoints.length; i += 2) {
      contourPairs.push([wasmResult.contourPoints[i], wasmResult.contourPoints[i + 1]]);
    }

    // Determine target tray display info
    const trays = this.posterStore.trays();
    const assignedTray = trays.find(t => t.id === targetTrayId);
    const trayColor = targetTrayId === 0 ? '#111111' : (assignedTray ? assignedTray.color : '#15803d');
    const trayLabel = targetTrayId === 0 ? 'BORDER TRAY' : `TRAY-0${targetTrayId} [${assignedTray?.name || 'INTERIOR'}]`;

    // Capture thumbnail of the rectified stage canvas
    const stageThumbnail = this.stageCanvas?.nativeElement.toDataURL('image/jpeg', 0.85);

    const piece: StoredPiece = {
      id: pieceId,
      trayId: targetTrayId,
      timestamp: Date.now(),
      polarities,
      tabWidthMm,
      confidence,
      contourPoints: contourPairs,
      normalizedProfiles: wasmResult.normalizedProfiles,
      thumbnailDataUrl: stageThumbnail
    };

    await this.storageService.savePiece(piece);
    this.lastPiece.set(piece);

    // Update InventoryStore reactive signals
    this.inventoryStore.totalIngested.update(c => c + 1);

    // Trigger whole-screen peripheral color flash (ING-03)
    this.triggerFlash(trayColor, trayLabel);
    this.isProcessing.set(false);
  }

  private triggerFlash(color: string, label: string): void {
    this.activeFlashColor.set(color);
    this.flashMessage.set(label);
    if (this.flashTimeout) clearTimeout(this.flashTimeout);
    this.flashTimeout = setTimeout(() => {
      this.activeFlashColor.set(null);
      this.flashMessage.set(null);
    }, 700);
  }
}
