import {
  Component,
  ElementRef,
  ViewChild,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
  untracked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { AppModeStore } from '../../core/state/app-mode.store';
import { CameraService } from '../../core/services/camera.service';
import { StorageService, StoredPiece } from '../../core/services/storage.service';
import { InventoryStore } from '../../core/state/inventory.store';
import { PosterStore } from '../../core/state/poster.store';
import { WasmEngineService, StagedPieceAnalysis, WasmEdgeAnalysis, WasmPieceAnalysis } from '../../core/services/wasm-engine.service';
import { TrayId } from '../../core/models/poster.model';

export interface DiagnosticLogEntry {
  timestamp: string;
  severity: 'INFO' | 'CV' | 'DETECT' | 'COMMIT' | 'EDGE' | 'ROUTE' | 'STORE' | 'STAGE' | 'WARN' | 'ERR';
  message: string;
}

export type EdgeDetail = WasmEdgeAnalysis;

export interface TrayDistanceRanking {
  trayId: number;
  trayName: string;
  color: string;
  distSq: number;
  isAssigned: boolean;
}

export interface LivePieceState {
  pieceIdPreview: number;
  center: { x: number; y: number };
  rotationAngleDeg: number;
  boundingWidthMm: number;
  boundingHeightMm: number;
  perimeterMm: number;
  areaMm2: number;
  aspectRatio: number;
  tabWidthMm: number;
  isBorder: boolean;
  isCorner: boolean;
  fgPixels: number;
  thresholdUsed: number;
  meanRgb: [number, number, number];
  meanLab: [number, number, number];
  textureGradient: number;
  edges: EdgeDetail[];
  corners: Array<{ x: number; y: number }>;
  contourPoints: Array<{ x: number; y: number }>;
  assignedTrayId: number;
  assignedTrayName: string;
  assignedTrayColor: string;
  confidence: number;
  trayRankings: TrayDistanceRanking[];
  binaryMask?: Uint8Array;
}

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
  @ViewChild('diagCanvas') diagCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('logContainerRef') logContainerRef!: ElementRef<HTMLDivElement>;

  // Continuous live piece detection state
  readonly livePieceDetected = signal<boolean>(false);
  readonly livePieceState = signal<LivePieceState | null>(null);

  // Stored piece state
  readonly lastCapturedPiece = signal<StoredPiece | null>(null);
  readonly selectedPiece = signal<StoredPiece | null>(null);
  readonly recentPieces = signal<StoredPiece[]>([]);
  readonly captureNotice = signal<string | null>(null);
  private captureNoticeTimeout: any = null;

  // Viewport B display mode ('DISSECT' = 4-Quadrant Dissected Edges, 'MASK' = Solid Binary Mask)
  readonly viewBMode = signal<'DISSECT' | 'MASK'>('DISSECT');

  // Candidate tray centroid rankings for piece inspected from queue
  readonly selectedPieceRankings = computed<TrayDistanceRanking[]>(() => {
    const sel = this.selectedPiece();
    if (!sel) return [];

    const trays = this.posterStore.trays();
    const centroids = this.posterStore.activeCentroids();
    const rankings: TrayDistanceRanking[] = [];

    const isBorderOrCorner = sel.trayId === 0 || sel.polarities.some(p => p === 'FLAT');

    if (isBorderOrCorner) {
      rankings.push({
        trayId: 0,
        trayName: '00 · BORDER & CORNERS',
        color: '#111111',
        distSq: 0.0,
        isAssigned: sel.trayId === 0
      });
    }

    const pLab = sel.meanLab || [50, 0, 0];
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      const tId = i + 1;
      const tInfo = trays.find(t => t.id === tId);

      const dl = pLab[0] - c.lab[0];
      const da = pLab[1] - c.lab[1];
      const db = pLab[2] - c.lab[2];
      const distSq = Math.round(((dl * dl + da * da + db * db) / 900.0) * 1000) / 1000;

      rankings.push({
        trayId: tId,
        trayName: `0${tId} · ${tInfo?.name || `TRAY-0${tId}`}`,
        color: tInfo?.color || '#525252',
        distSq,
        isAssigned: sel.trayId === tId
      });
    }

    if (!isBorderOrCorner) {
      rankings.push({
        trayId: 0,
        trayName: '00 · BORDER & CORNERS',
        color: '#111111',
        distSq: 1.0,
        isAssigned: sel.trayId === 0
      });
    }

    rankings.sort((a, b) => {
      if (a.isAssigned) return -1;
      if (b.isAssigned) return 1;
      return a.distSq - b.distSq;
    });

    return rankings;
  });

  // Real-time operator diagnostic log stream
  readonly diagnosticLogs = signal<DiagnosticLogEntry[]>([]);
  readonly logFilter = signal<string>('ALL');
  readonly autoScrollLogs = signal<boolean>(true);

  // Filtered log computed stream
  readonly filteredLogs = computed(() => {
    const f = this.logFilter();
    const logs = this.diagnosticLogs();
    if (f === 'ALL') return logs;
    return logs.filter(l => l.severity === f);
  });

  // Layer toggles
  readonly showContours = signal<boolean>(true);
  readonly showEdges = signal<boolean>(true);
  readonly showChords = signal<boolean>(true);
  readonly showCorners = signal<boolean>(true);
  readonly showBadges = signal<boolean>(true);
  readonly showReticle = signal<boolean>(true);

  readonly isProcessing = signal<boolean>(false);
  readonly scanStatusMessage = signal<string | null>(null);

  // Ground Truth Benchmark Workbench state
  readonly isGtMode = signal<boolean>(false);
  readonly gtCorners = signal<{ x: number; y: number }[] | null>(null);
  readonly gtDetectedCorners = signal<{ x: number; y: number }[] | null>(null);
  readonly gtEdges = signal<('Tab' | 'Hole' | 'Flat')[]>(['Tab', 'Tab', 'Tab', 'Tab']);
  readonly draggingCornerIdx = signal<number | null>(null);
  readonly gtSavedCount = signal<number>(0);
  readonly gtSaveStatus = signal<string | null>(null);

  readonly gtVerifiedType = computed<'Interior' | 'Border' | 'Corner'>(() => {
    const edges = this.gtEdges();
    const flatCount = edges.filter(e => e === 'Flat').length;
    if (flatCount >= 2) return 'Corner';
    if (flatCount === 1) return 'Border';
    return 'Interior';
  });

  private animFrameId: number | null = null;
  private lastDewarpedBuffer: Uint8Array | null = null;

  // Calibrated homography & lens distortion loaded from shared storage
  readonly corners = signal<[ { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number } ]>([
    { x: 120, y: 80 },
    { x: 520, y: 80 },
    { x: 520, y: 400 },
    { x: 120, y: 400 }
  ]);
  readonly lensK1 = signal<number>(0.0);
  readonly sensitivity = signal<number>(25.0);

  constructor() {
    // One-shot scan trigger for capturing piece
    effect(() => {
      const trigger = this.appModeStore.scanTrigger();
      if (trigger > 0) {
        untracked(() => {
          if (!this.isProcessing()) {
            this.handlePrimaryAction();
          }
        });
      }
    });

    // Reset / clear trigger via Escape
    effect(() => {
      const reset = this.appModeStore.scanResetTrigger();
      if (reset > 0) {
        untracked(() => {
          this.clearArtifacts();
        });
      }
    });
  }

  async ngOnInit(): Promise<void> {
    this.addLog('INFO', 'Ingestion workstation initializing...');
    this.loadCalibration();
    this.fetchGtCount();
    // Sync tray capacities directly from poster clustering counts (e.g. Forest: 90 pcs, Border: 124 pcs)
    this.inventoryStore.syncFromPoster(this.posterStore.trays(), this.posterStore.stats().borderPieces);
    await this.initInventoryAndQueue();
    await this.cameraService.refreshDevices();
    await this.cameraService.startStream(this.videoRef?.nativeElement);

    if (this.cameraService.isStreaming()) {
      const res = this.cameraService.activeResolution();
      const currentDev = this.cameraService.availableDevices().find(d => d.deviceId === this.cameraService.selectedDeviceId());
      this.addLog('CV', `Sensor online: ${currentDev?.label || 'Camera'} (${res.width}x${res.height})`);
    } else {
      this.addLog('WARN', 'Camera stream waiting for sensor connection.');
    }

    this.startStageRenderingLoop();
  }

  /**
   * Switches video acquisition device on user selection
   */
  async onCameraChange(event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    if (!select || !select.value) return;
    const deviceId = select.value;
    const dev = this.cameraService.availableDevices().find(d => d.deviceId === deviceId);
    this.addLog('INFO', `Switching sensor camera to: ${dev?.label || deviceId}`);
    await this.cameraService.switchDevice(deviceId, this.videoRef?.nativeElement);
    if (this.cameraService.isStreaming()) {
      const res = this.cameraService.activeResolution();
      this.addLog('CV', `Sensor switched online: ${res.width}x${res.height}`);
    } else {
      this.addLog('ERR', 'Selected sensor failed to open.');
    }
  }

  ngOnDestroy(): void {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    if (this.captureNoticeTimeout) clearTimeout(this.captureNoticeTimeout);
  }

  loadCalibration(): void {
    const cal = this.storageService.getOpticalCalibration();
    this.corners.set(cal.corners);
    this.lensK1.set(cal.lensK1);
    this.sensitivity.set(cal.sensitivity);
    this.addLog('INFO', `Stage calibrated: k1=${cal.lensK1.toFixed(3)}, sensitivity=${cal.sensitivity.toFixed(1)}`);
  }

  /**
   * Initializes inventory tray counts and queue from stored pieces
   */
  async initInventoryAndQueue(): Promise<void> {
    try {
      const allPieces = await this.storageService.getAllPieces();
      // Sync inventory store with actual stored piece count
      this.inventoryStore.syncFromPieces(allPieces);
      this.recentPieces.set(allPieces.slice(-15).reverse());

      if (allPieces.length > 0) {
        const last = allPieces[allPieces.length - 1];
        this.lastCapturedPiece.set(last);
        this.selectedPiece.set(null);
        this.addLog('STORE', `Synchronized inventory: ${allPieces.length} pieces in storage.`);
      } else {
        this.addLog('INFO', 'Inventory empty. Piece numbering will start at Piece #1.');
      }
    } catch {
      // Storage fallback
    }
  }

  async retryCamera(): Promise<void> {
    this.addLog('INFO', 'Reconnecting camera sensor...');
    await this.cameraService.startStream(this.videoRef?.nativeElement);
    if (this.cameraService.isStreaming()) {
      const res = this.cameraService.activeResolution();
      this.addLog('CV', `Camera reconnected: ${res.width}x${res.height}`);
    } else {
      this.addLog('ERR', 'Sensor reconnection failed.');
    }
  }

  /**
   * Continuous dewarping and live CV evaluation loop
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
    if (!video || !canvas || !this.cameraService.isStreaming() || video.videoWidth === 0) {
      this.drawStageOverlay();
      this.drawDiagnosticsCanvas();
      return;
    }

    if (this.isGtMode()) {
      // In Ground Truth Labeling Mode, stage frame is frozen to prevent jitter while dragging pins
      this.drawStageOverlay();
      this.drawDiagnosticsCanvas();
      return;
    }

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
      this.lastDewarpedBuffer = dewarped;
      const stageCtx = canvas.getContext('2d');
      if (stageCtx) {
        const stageImgData = stageCtx.createImageData(384, 384);
        stageImgData.data.set(dewarped);
        stageCtx.putImageData(stageImgData, 0, 0);
      }

    }

    this.drawStageOverlay();
    this.drawDiagnosticsCanvas();
  }

  /**
   * Action: SCAN PIECE
   * Triggers deterministic single-frame piece extraction from the rectified stage buffer.
   * Runs the Rust cv-engine segmentation, contour tracing, and edge classification.
   * Locks in telemetry and tray recommendation with 0 wobble and 0 frame-to-frame jitter.
   */
  scanCurrentPiece(): void {
    if (this.isProcessing()) return;

    let dewarped = this.lastDewarpedBuffer;
    if (!dewarped) {
      const video = this.videoRef?.nativeElement;
      if (!video || !this.cameraService.isStreaming()) {
        this.scanStatusMessage.set('SENSOR STREAM OFFLINE');
        return;
      }
      const frameCanvas = this.cameraService.captureFrame(video);
      if (!frameCanvas) return;
      const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      const imgData = ctx.getImageData(0, 0, frameCanvas.width, frameCanvas.height);
      const rgba = new Uint8Array(imgData.data.buffer);
      const pts = this.corners();
      const cornerCoords: [number, number, number, number, number, number, number, number] = [
        pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y, pts[3].x, pts[3].y
      ];
      dewarped = this.wasmEngine.dewarpQuad(rgba, frameCanvas.width, frameCanvas.height, cornerCoords, 384, 384, this.lensK1());
      if (dewarped) this.lastDewarpedBuffer = dewarped;
    }

    if (!dewarped) {
      this.scanStatusMessage.set('FAILED TO ACQUIRE STAGE FRAME');
      return;
    }

    const centroids = this.posterStore.activeCentroids();
    const centroidsJson = JSON.stringify(centroids);
    const analysis = this.wasmEngine.analyzeStagedPiece(dewarped, 384, 384, this.sensitivity(), centroidsJson);
    if (!analysis || !analysis.piece) {
      this.scanStatusMessage.set('STAGE CLEAR · PLACE PIECE ON SENSOR MAT');
      this.addLog('WARN', 'Scan attempted: Stage empty or no piece detected.');
      this.livePieceDetected.set(false);
      this.livePieceState.set(null);
      this.drawStageOverlay();
      this.drawDiagnosticsCanvas();
      return;
    }

    const p = analysis.piece;
    if (this.selectedPiece()) {
      this.selectedPiece.set(null);
    }

    const trays = this.posterStore.trays();
    const trayRankings: TrayDistanceRanking[] = (p.trayRankings || []).map(r => {
      const tInfo = trays.find(t => t.id === r.trayId);
      const trayName = r.trayId === 0
        ? '00 · BORDER & CORNERS'
        : `0${r.trayId} · ${tInfo?.name || `TRAY-0${r.trayId}`}`;
      const color = r.trayId === 0 ? '#111111' : (tInfo?.color || '#525252');
      return {
        trayId: r.trayId,
        trayName,
        color,
        distSq: r.distSq,
        isAssigned: r.isAssigned
      };
    });

    const assignedTrayInfo = trays.find(t => t.id === p.assignedTrayId);
    const assignedTrayName = p.assignedTrayId === 0
      ? '00 · BORDER & CORNERS'
      : `0${p.assignedTrayId} · ${assignedTrayInfo?.name || `TRAY-0${p.assignedTrayId}`}`;
    const assignedTrayColor = p.assignedTrayId === 0 ? '#111111' : (assignedTrayInfo?.color || '#15803d');

    const nextPieceId = this.inventoryStore.totalIngested() + 1;

    const liveState: LivePieceState = {
      pieceIdPreview: nextPieceId,
      center: p.center,
      rotationAngleDeg: p.rotationAngleDeg,
      boundingWidthMm: p.boundingWidthMm,
      boundingHeightMm: p.boundingHeightMm,
      perimeterMm: p.perimeterMm,
      areaMm2: p.areaMm2,
      aspectRatio: p.aspectRatio,
      tabWidthMm: p.tabWidthMm,
      isBorder: p.isBorder,
      isCorner: p.isCorner,
      fgPixels: analysis.fgPixels,
      thresholdUsed: analysis.thresholdUsed,
      meanRgb: p.meanRgb,
      meanLab: p.meanLab,
      textureGradient: p.textureGradient,
      edges: p.edges,
      corners: p.corners,
      contourPoints: p.contourPoints,
      assignedTrayId: p.assignedTrayId,
      assignedTrayName,
      assignedTrayColor,
      confidence: p.confidence,
      trayRankings,
      binaryMask: analysis.binaryMask
    };

    this.livePieceState.set(liveState);
    this.livePieceDetected.set(true);
    this.scanStatusMessage.set(null);

    this.addLog('DETECT', `Scanned Piece #${nextPieceId}: ${p.edges.map(e => e.polarity).join('/')} -> ${assignedTrayName} (${(p.confidence * 100).toFixed(0)}%)`);
    for (const e of p.edges) {
      const sign = e.depthMm > 0 ? '+' : '';
      this.addLog('EDGE', `${e.name}: ${e.polarity} (chord ${e.chordLengthMm.toFixed(1)}mm, depth ${sign}${e.depthMm.toFixed(1)}mm)`);
    }
    this.addLog('ROUTE', `Routing: ${assignedTrayName} (Conf: ${(p.confidence * 100).toFixed(0)}%)`);

    this.drawStageOverlay();
    this.drawDiagnosticsCanvas();
  }

  /**
   * Combined trigger action (Spacebar handler / Primary Action button)
   * If no piece is currently staged: runs scanCurrentPiece().
   * If a piece is already staged: commits it to the designated sorting tray.
   */
  async handlePrimaryAction(): Promise<void> {
    if (this.isProcessing()) return;
    if (this.isGtMode()) {
      await this.saveGroundTruth();
    } else if (this.livePieceDetected()) {
      await this.captureCurrentPiece();
    } else {
      this.scanCurrentPiece();
    }
  }

  /**
   * Superimposes CV artifacts (contours, color-coded edges, chords, corner brackets, badges)
   * on top of Viewport A with pixel-snapped coordinates to eliminate wobbling.
   */
  private drawStageOverlay(): void {
    const overlay = this.stageOverlayCanvas?.nativeElement;
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 384, 384);

    if (this.isGtMode()) {
      this.drawGroundTruthOverlay(ctx);
      return;
    }

    // 1. Stage Frame & 96mm Metric Grounding Rulers
    if (this.showReticle()) {
      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(0.5, 0.5, 383, 383);

      ctx.strokeStyle = '#525252';
      ctx.beginPath();
      for (let x = 96; x < 384; x += 96) {
        ctx.moveTo(x, 0); ctx.lineTo(x, 6);
        ctx.moveTo(x, 384); ctx.lineTo(x, 378);
      }
      for (let y = 96; y < 384; y += 96) {
        ctx.moveTo(0, y); ctx.lineTo(6, y);
        ctx.moveTo(384, y); ctx.lineTo(378, y);
      }
      // Center crosshair (24px)
      ctx.moveTo(192 - 12, 192); ctx.lineTo(192 + 12, 192);
      ctx.moveTo(192, 192 - 12); ctx.lineTo(192, 192 + 12);
      ctx.stroke();
    }

    const state = this.livePieceState();
    if (!state || !this.livePieceDetected()) return;

    // 2. Continuous Piece Contour: smooth quadratic Bézier curves with high-contrast #00e676 stroke
    if (this.showContours() && state.contourPoints.length >= 6) {
      const pts = state.contourPoints;
      ctx.save();
      ctx.beginPath();
      const firstMidX = (pts[0].x + pts[1].x) / 2;
      const firstMidY = (pts[0].y + pts[1].y) / 2;
      ctx.moveTo(firstMidX, firstMidY);
      for (let i = 1; i < pts.length; i++) {
        const next = pts[(i + 1) % pts.length];
        const midX = (pts[i].x + next.x) / 2;
        const midY = (pts[i].y + next.y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(0, 230, 118, 0.05)';
      ctx.fill();
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();
    }

    // 3. Baseline Chords
    if (this.showChords() && state.edges.length > 0) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#525252';
      ctx.lineWidth = 1.0;
      for (const e of state.edges) {
        ctx.beginPath();
        ctx.moveTo(e.startCorner.x, e.startCorner.y);
        ctx.lineTo(e.endCorner.x, e.endCorner.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 4. Classified Cardinal Edges (TAB = Green #00e676, HOLE = Amber #f59e0b, FLAT = Cyan #38bdf8)
    if (this.showEdges() && state.edges.length > 0) {
      for (const e of state.edges) {
        if (e.curvePoints.length < 2) continue;
        ctx.beginPath();
        ctx.lineWidth = 2.0;
        if (e.polarity === 'TAB') ctx.strokeStyle = '#00e676';
        else if (e.polarity === 'HOLE') ctx.strokeStyle = '#f59e0b';
        else ctx.strokeStyle = '#38bdf8';

        ctx.moveTo(e.curvePoints[0].x, e.curvePoints[0].y);
        for (let i = 1; i < e.curvePoints.length; i++) {
          ctx.lineTo(e.curvePoints[i].x, e.curvePoints[i].y);
        }
        ctx.stroke();
      }
    }

    // 5. Four Die-Cut Corner Reticles (pixel-snapped to eliminate wobbling)
    if (this.showCorners() && state.corners.length >= 4) {
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 1.5;
      ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';

      for (let i = 0; i < state.corners.length; i++) {
        const c = state.corners[i];
        const cx = Math.round(c.x);
        const cy = Math.round(c.y);
        ctx.strokeRect(cx - 4.5, cy - 4.5, 9, 9);

        ctx.fillStyle = '#111111';
        const lx = cx < 192 ? cx - 18 : cx + 8;
        const ly = cy < 192 ? cy - 8 : cy + 14;
        ctx.fillText(`C${i}`, lx, ly);
      }
    }

    // 6. Midpoint Edge Classification Badges
    if (this.showBadges() && state.edges.length > 0) {
      ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
      for (const e of state.edges) {
        const sign = e.depthMm > 0 ? '+' : '';
        const depthStr = e.polarity === 'FLAT' ? '' : ` (${sign}${e.depthMm.toFixed(1)}mm)`;
        const badgeText = `${e.direction}:${e.polarity}${depthStr}`;

        const textMetrics = ctx.measureText(badgeText);
        const boxW = textMetrics.width + 8;
        const boxH = 18;
        const bx = Math.round(e.midPoint.x - boxW / 2);
        const by = Math.round(e.midPoint.y - boxH / 2);

        ctx.fillStyle = '#111111';
        ctx.fillRect(bx, by, boxW, boxH);
        ctx.strokeStyle = '#d4d4d4';
        ctx.lineWidth = 1.0;
        ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);

        ctx.fillStyle = '#f5f5f5';
        ctx.fillText(badgeText, bx + 4, by + 13);
      }
    }
  }

  /**
   * Renders Viewport B: either 4-Quadrant Dissected Edges (DISSECT),
   * 4 Edge Baseline Waveforms (PROFILES), or Otsu Binary Mask (MASK)
   */
  private drawDiagnosticsCanvas(): void {
    const canvas = this.diagCanvas?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mode = this.viewBMode();
    const state = this.livePieceState();

    if (mode === 'DISSECT') {
      this.drawDissectedEdges(ctx, state);
    } else {
      // MASK mode: render solid silhouette mask from tracked contour points (eliminates deep black dots/holes)
      if (state && state.contourPoints && state.contourPoints.length >= 6) {
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, 384, 384);

        ctx.fillStyle = '#f5f5f5';
        ctx.beginPath();
        ctx.moveTo(state.contourPoints[0].x, state.contourPoints[0].y);
        for (let i = 1; i < state.contourPoints.length; i++) {
          ctx.lineTo(state.contourPoints[i].x, state.contourPoints[i].y);
        }
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#111111';
        ctx.fillRect(0, 0, 384, 24);
        ctx.fillStyle = '#f5f5f5';
        ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
        const pct = ((state.fgPixels / (384 * 384)) * 100).toFixed(1);
        ctx.fillText(`SOLID SEGMENTATION MASK · FG: ${state.fgPixels} PX (${pct}%)`, 8, 16);
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 384, 384);
        ctx.strokeStyle = '#e5e5e5';
        ctx.lineWidth = 1.0;
        for (let i = 48; i < 384; i += 48) {
          ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 384); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(384, i); ctx.stroke();
        }
        ctx.fillStyle = '#525252';
        ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText('STANDBY · PLACE PIECE ON MAT TO EXTRACT MASK', 24, 192);
      }
    }
  }

  /**
   * Renders a 4-Quadrant Dissected Edge view showing each border (North, East, South, West)
   * with isolated contour curve, zero baseline chord, corner anchors, and dimension callouts.
   */
  private drawDissectedEdges(ctx: CanvasRenderingContext2D, state: LivePieceState | null): void {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 384, 384);

    if (!state || !state.edges || state.edges.length < 4) {
      // Standby quadrant grid
      ctx.strokeStyle = '#e5e5e5';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(192, 0); ctx.lineTo(192, 384);
      ctx.moveTo(0, 192); ctx.lineTo(384, 192);
      ctx.stroke();

      ctx.fillStyle = '#525252';
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText('STANDBY · PLACE PIECE ON MAT FOR DISSECTED EDGES', 12, 192);
      return;
    }

    const quadrants = [
      { x: 0, y: 0, edgeIdx: 0, label: 'E0 · NORTH', startC: 'C0', endC: 'C1' },
      { x: 192, y: 0, edgeIdx: 1, label: 'E1 · EAST',  startC: 'C1', endC: 'C2' },
      { x: 0, y: 192, edgeIdx: 2, label: 'E2 · SOUTH', startC: 'C2', endC: 'C3' },
      { x: 192, y: 192, edgeIdx: 3, label: 'E3 · WEST',  startC: 'C3', endC: 'C0' }
    ];

    for (const q of quadrants) {
      const edge = state.edges[q.edgeIdx];
      const qx = q.x;
      const qy = q.y;

      // 1. Quadrant border & divider (1px rule)
      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(qx + 0.5, qy + 0.5, 191, 191);

      // 2. Inverted Header Bar
      ctx.fillStyle = '#111111';
      ctx.fillRect(qx + 1, qy + 1, 190, 24);

      ctx.fillStyle = '#f5f5f5';
      ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(q.label, qx + 6, qy + 16);

      // Polarity badge pill
      const polColor = edge.polarity === 'TAB' ? '#15803d' : edge.polarity === 'HOLE' ? '#b45309' : '#0284c7';
      ctx.fillStyle = polColor;
      ctx.fillRect(qx + 112, qy + 4, 74, 16);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(edge.polarity === 'FLAT' ? 'FLAT BDR' : edge.polarity, qx + 116, qy + 16);

      // 3. Metric subline
      ctx.fillStyle = '#525252';
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
      const sign = edge.depthMm > 0 ? '+' : '';
      const depthText = edge.polarity === 'FLAT' ? 'FLAT (0.0mm)' : `${sign}${edge.depthMm.toFixed(2)}mm`;
      ctx.fillText(`CHORD: ${edge.chordLengthMm.toFixed(1)}mm · ${depthText}`, qx + 6, qy + 40);

      // 4. Dissected baseline chord
      const baseY = qy + 115;
      const startX = qx + 20;
      const endX = qx + 172;
      const drawWidth = endX - startX;

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(startX, baseY);
      ctx.lineTo(endX, baseY);
      ctx.stroke();
      ctx.restore();

      // End tick marks & corner labels
      ctx.strokeStyle = '#525252';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(startX, baseY - 6); ctx.lineTo(startX, baseY + 6);
      ctx.moveTo(endX, baseY - 6); ctx.lineTo(endX, baseY + 6);
      ctx.stroke();

      ctx.fillStyle = '#525252';
      ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(q.startC, startX - 4, baseY + 18);
      ctx.fillText(q.endC, endX - 8, baseY + 18);

      // 5. Draw isolated edge contour
      const profile = edge.normalizedProfile;
      ctx.beginPath();
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = polColor;

      if (profile && profile.length > 0) {
        for (let k = 0; k < profile.length; k++) {
          const px = startX + (k / (profile.length - 1)) * drawWidth;
          // Profile deviation in pixels: TAB goes up (-), HOLE goes down (+)
          const py = baseY - (profile[k] * 45);
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      } else {
        // Fallback straight baseline
        ctx.moveTo(startX, baseY);
        ctx.lineTo(endX, baseY);
      }
      ctx.stroke();

      // 6. Polarity dimension indicator callout
      if (edge.polarity === 'TAB') {
        ctx.fillStyle = '#15803d';
        ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText(`+${edge.depthMm.toFixed(1)}mm TAB`, qx + 58, baseY - 28);
      } else if (edge.polarity === 'HOLE') {
        ctx.fillStyle = '#b45309';
        ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText(`-${Math.abs(edge.depthMm).toFixed(1)}mm HOLE`, qx + 56, baseY + 36);
      } else {
        ctx.fillStyle = '#0284c7';
        ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText('FLAT BORDER', qx + 54, baseY - 8);
      }
    }
  }

  /**
   * Action: CAPTURE & COMMIT PIECE
   * Triggered by pressing Space bar or clicking #capture-piece-btn.
   * Stores piece, increments tray count, updates queue, and emits commit log.
   */
  async captureCurrentPiece(): Promise<void> {
    if (this.isProcessing()) return;

    const state = this.livePieceState();
    if (!state || !this.livePieceDetected()) {
      this.scanStatusMessage.set('STAGE EMPTY — CANNOT CAPTURE');
      this.addLog('WARN', 'Capture rejected: No piece currently detected on stage arena.');
      return;
    }

    this.isProcessing.set(true);
    this.scanStatusMessage.set(null);

    // Compute piece ID (starts strictly at 1 for first piece, or max+1)
    const existingPieces = await this.storageService.getAllPieces();
    let pieceId = 1;
    if (existingPieces.length > 0) {
      const maxId = Math.max(...existingPieces.map(p => p.id));
      pieceId = maxId + 1;
    }

    // Convert contour to coordinate pairs
    const contourPairs: [number, number][] = state.contourPoints.map(p => [p.x, p.y]);

    // Capture stage thumbnail
    const stageThumbnail = this.stageCanvas?.nativeElement.toDataURL('image/jpeg', 0.85);

    const polarities: [string, string, string, string] = [
      state.edges[0]?.polarity || 'FLAT',
      state.edges[1]?.polarity || 'FLAT',
      state.edges[2]?.polarity || 'FLAT',
      state.edges[3]?.polarity || 'FLAT'
    ];

    const normalizedProfiles: number[][] = state.edges.map(e => e.normalizedProfile || []);

    const piece: StoredPiece = {
      id: pieceId,
      trayId: state.assignedTrayId,
      timestamp: Date.now(),
      polarities,
      tabWidthMm: state.tabWidthMm,
      confidence: state.confidence,
      contourPoints: contourPairs,
      normalizedProfiles,
      meanLab: state.meanLab,
      thumbnailDataUrl: stageThumbnail
    };

    try {
      await this.storageService.savePiece(piece);
      this.lastCapturedPiece.set(piece);
      this.selectedPiece.set(null);
      this.recentPieces.update(list => [piece, ...list.slice(0, 14)]);

      // Increment inventory tray fill
      this.inventoryStore.incrementTray(piece.trayId);

      this.addLog('COMMIT', `Captured piece #${pieceId} -> Committed to ${state.assignedTrayName} (Confidence: ${(state.confidence * 100).toFixed(0)}%)`);

      // Temporary non-blocking confirmation badge in header
      this.captureNotice.set(`CAPTURED #${pieceId} -> ${state.assignedTrayName}`);
      if (this.captureNoticeTimeout) clearTimeout(this.captureNoticeTimeout);
      this.captureNoticeTimeout = setTimeout(() => {
        this.captureNotice.set(null);
      }, 2500);

      // Clear stage overlay and diagnostic view ready for next piece
      this.livePieceState.set(null);
      this.livePieceDetected.set(false);
      this.drawStageOverlay();
      this.drawDiagnosticsCanvas();

    } catch (err: any) {
      this.addLog('ERR', `Failed to save piece #${pieceId}: ${err?.message || err}`);
    }

    this.isProcessing.set(false);
  }

  /**
   * Action: DELETE & RETAKE PIECE
   * Decrements tray fill count, deletes piece from IndexedDB, and updates queue.
   */
  async deleteCapturedPiece(pieceId: number, event?: Event): Promise<void> {
    if (event) event.stopPropagation();

    try {
      const piece = this.recentPieces().find(p => p.id === pieceId) ||
                    (this.lastCapturedPiece()?.id === pieceId ? this.lastCapturedPiece() : null);

      await this.storageService.deletePiece(pieceId);

      if (piece) {
        this.inventoryStore.decrementTray(piece.trayId);
      } else {
        this.inventoryStore.totalIngested.update(c => Math.max(0, c - 1));
      }

      this.recentPieces.update(list => list.filter(p => p.id !== pieceId));

      if (this.selectedPiece()?.id === pieceId) {
        this.selectedPiece.set(null);
      }
      if (this.lastCapturedPiece()?.id === pieceId) {
        const remaining = this.recentPieces();
        this.lastCapturedPiece.set(remaining.length > 0 ? remaining[0] : null);
      }

      this.addLog('STORE', `Deleted piece #${pieceId} from inventory. Mat ready to retake.`);
    } catch (err: any) {
      this.addLog('ERR', `Failed to delete piece #${pieceId}: ${err?.message || err}`);
    }
  }

  selectPieceForInspection(piece: StoredPiece): void {
    this.selectedPiece.set(piece);
    this.addLog('INFO', `Inspecting piece #${piece.id} from Tray T-0${piece.trayId}`);
  }

  clearArtifacts(): void {
    if (this.isGtMode()) {
      this.exitGtMode();
      this.addLog('INFO', 'Exited Ground Truth workbench [ESC]');
      return;
    }
    this.livePieceState.set(null);
    this.livePieceDetected.set(false);
    this.scanStatusMessage.set(null);
    this.drawStageOverlay();
    this.drawDiagnosticsCanvas();
    this.addLog('INFO', 'Cleared stage overlay [ESC]');
  }

  clearLogs(): void {
    this.diagnosticLogs.set([]);
  }

  toggleAutoScroll(): void {
    this.autoScrollLogs.update(v => !v);
  }

  setLogFilter(filter: string): void {
    this.logFilter.set(filter);
  }

  setViewBMode(mode: 'DISSECT' | 'MASK'): void {
    this.viewBMode.set(mode);
    this.drawDiagnosticsCanvas();
  }

  async reassignPieceTray(pieceId: number, newTrayId: number): Promise<void> {
    const sel = this.selectedPiece();
    if (!sel || sel.id !== pieceId) return;
    const oldTrayId = sel.trayId;
    if (oldTrayId === newTrayId) return;

    const updatedPiece: StoredPiece = { ...sel, trayId: newTrayId };
    try {
      await this.storageService.savePiece(updatedPiece);
      this.inventoryStore.movePieceTray(oldTrayId, newTrayId);
      this.selectedPiece.set(updatedPiece);
      this.recentPieces.update(list =>
        list.map(p => p.id === pieceId ? updatedPiece : p)
      );
      const oldName = oldTrayId === 0 ? 'BORDER & CORNERS' : (this.posterStore.getTray(oldTrayId)?.name || `T-0${oldTrayId}`);
      const newName = newTrayId === 0 ? 'BORDER & CORNERS' : (this.posterStore.getTray(newTrayId)?.name || `T-0${newTrayId}`);
      this.addLog('STORE', `Piece #${pieceId} moved: ${oldName} -> ${newName}`);
    } catch (err: any) {
      this.addLog('ERR', `Failed to move piece #${pieceId}: ${err?.message || err}`);
    }
  }

  closeQueueInspection(): void {
    this.selectedPiece.set(null);
  }

  toggleLayer(layer: 'contours' | 'edges' | 'chords' | 'corners' | 'badges' | 'reticle'): void {
    switch (layer) {
      case 'contours': this.showContours.update(v => !v); break;
      case 'edges': this.showEdges.update(v => !v); break;
      case 'chords': this.showChords.update(v => !v); break;
      case 'corners': this.showCorners.update(v => !v); break;
      case 'badges': this.showBadges.update(v => !v); break;
      case 'reticle': this.showReticle.update(v => !v); break;
    }
    this.drawStageOverlay();
  }

  addLog(severity: DiagnosticLogEntry['severity'], message: string): void {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const mmm = String(d.getMilliseconds()).padStart(3, '0');
    const timestamp = `${hh}:${mm}:${ss}.${mmm}`;

    this.diagnosticLogs.update(logs => {
      const next = [...logs, { timestamp, severity, message }];
      if (next.length > 500) next.shift();
      return next;
    });

    if (this.autoScrollLogs()) {
      setTimeout(() => {
        const el = this.logContainerRef?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      }, 0);
    }
  }

  // =========================================================================
  // GROUND TRUTH BENCHMARK WORKBENCH (Truthful Reporting & Offline Benchmarking)
  // =========================================================================

  /**
   * Enters Ground Truth Benchmark Labeling mode.
   * Freezes the currently staged piece for human verification without camera wobble.
   * Preserves detected corners and polarities for editing and keeps raw CV detections.
   */
  enterGtMode(): void {
    const state = this.livePieceState();
    if (!state || state.corners.length < 4) {
      this.scanStatusMessage.set('SCAN A PIECE FIRST BEFORE LABELING GROUND TRUTH');
      return;
    }

    this.isGtMode.set(true);
    this.gtCorners.set(state.corners.map(c => ({ x: c.x, y: c.y })));
    this.gtDetectedCorners.set(state.corners.map(c => ({ x: c.x, y: c.y })));
    this.gtEdges.set(state.edges.map(e => {
      if (e.polarity === 'TAB') return 'Tab';
      if (e.polarity === 'HOLE') return 'Hole';
      return 'Flat';
    }));
    this.gtSaveStatus.set(null);
    this.fetchGtCount();
    this.addLog('INFO', 'Entered Ground Truth Workbench: drag corner pins & toggle edge polarities');
    this.drawStageOverlay();
  }

  /**
   * Exits Ground Truth Benchmark Labeling mode back to normal stage inspection.
   */
  exitGtMode(): void {
    this.isGtMode.set(false);
    this.gtCorners.set(null);
    this.gtDetectedCorners.set(null);
    this.draggingCornerIdx.set(null);
    this.gtSaveStatus.set(null);
    this.drawStageOverlay();
  }

  /**
   * Toggles verified edge polarity between Tab, Hole, and Flat.
   */
  toggleGtEdge(edgeIdx: number, type: 'Tab' | 'Hole' | 'Flat'): void {
    const current = [...this.gtEdges()];
    current[edgeIdx] = type;
    this.gtEdges.set(current);
    this.drawStageOverlay();
  }

  /**
   * Retrieves count of existing ground-truth fixtures from local server.
   */
  async fetchGtCount(): Promise<void> {
    try {
      const res = await fetch('/api/ground-truth-count');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.count === 'number') this.gtSavedCount.set(data.count);
        return;
      }
    } catch {}

    try {
      const res = await fetch('http://localhost:4201/api/ground-truth-count');
      if (res.ok) {
        const data = await res.json();
        if (typeof data.count === 'number') this.gtSavedCount.set(data.count);
      }
    } catch {}
  }

  /**
   * Pointer down handler on Viewport A canvas for dragging GT corner pins.
   */
  onStagePointerDown(event: PointerEvent): void {
    if (!this.isGtMode()) return;
    const corners = this.gtCorners();
    if (!corners || corners.length < 4) return;

    const canvas = this.stageOverlayCanvas?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);

    for (let i = 0; i < corners.length; i++) {
      const d = Math.hypot(corners[i].x - x, corners[i].y - y);
      if (d < 22) {
        this.draggingCornerIdx.set(i);
        (event.target as HTMLElement).setPointerCapture(event.pointerId);
        this.drawStageOverlay();
        return;
      }
    }
  }

  /**
   * Pointer move handler: drags pin and snaps to closest real contour point.
   */
  onStagePointerMove(event: PointerEvent): void {
    const dragIdx = this.draggingCornerIdx();
    if (!this.isGtMode() || dragIdx === null) return;
    const corners = this.gtCorners();
    const state = this.livePieceState();
    if (!corners || !state) return;

    const canvas = this.stageOverlayCanvas?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(384, (event.clientX - rect.left) * (canvas.width / rect.width)));
    const y = Math.max(0, Math.min(384, (event.clientY - rect.top) * (canvas.height / rect.height)));

    // Snap to closest contour point within 40px radius
    let bestPt = { x, y };
    let minDist = 40.0;
    for (const pt of state.contourPoints) {
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (d < minDist) {
        minDist = d;
        bestPt = { x: pt.x, y: pt.y };
      }
    }

    const updated = [...corners];
    updated[dragIdx] = bestPt;
    this.gtCorners.set(updated);
    this.drawStageOverlay();
  }

  /**
   * Pointer up handler: releases pin drag capture.
   */
  onStagePointerUp(event: PointerEvent): void {
    if (this.draggingCornerIdx() !== null) {
      this.draggingCornerIdx.set(null);
      try {
        (event.target as HTMLElement).releasePointerCapture(event.pointerId);
      } catch {}
      this.drawStageOverlay();
    }
  }

  /**
   * Saves ground truth benchmark fixture to datasets/ground_truth/
   * Schema matches cv-engine/tests/test_ground_truth.rs exactly.
   */
  async saveGroundTruth(): Promise<void> {
    const state = this.livePieceState();
    const corners = this.gtCorners();
    if (!state || !corners || corners.length < 4) return;

    const stageCanvas = this.stageCanvas?.nativeElement;
    const dataUrl = stageCanvas ? stageCanvas.toDataURL('image/jpeg', 0.85) : undefined;

    const edges = this.gtEdges();
    const verifiedType = this.gtVerifiedType();
    const id = `piece_gt_${Date.now()}`;

    const payload = {
      id,
      timestamp: new Date().toISOString(),
      expected_type: verifiedType,
      expected_edges: edges,
      corners: corners.map(c => ({ x: c.x, y: c.y })),
      detected_corners: (this.gtDetectedCorners() || state.corners).map(c => ({ x: c.x, y: c.y })),
      contour_points: state.contourPoints.map(p => ({ x: p.x, y: p.y })),
      imageJpegBase64: dataUrl,
    };

    this.gtSaveStatus.set('SAVING BENCHMARK FIXTURE...');

    try {
      let saved = false;
      let savedFile = `${id}.json`;

      // Try proxy / relative endpoint first
      try {
        const res = await fetch('/api/save-ground-truth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          const result = await res.json();
          if (result.success) {
            saved = true;
            savedFile = result.file || savedFile;
            if (typeof result.count === 'number') this.gtSavedCount.set(result.count);
          }
        }
      } catch {
        // Fallback to direct fixture-server port
        try {
          const res = await fetch('http://localhost:4201/api/save-ground-truth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (res.ok) {
            const result = await res.json();
            if (result.success) {
              saved = true;
              savedFile = result.file || savedFile;
              if (typeof result.count === 'number') this.gtSavedCount.set(result.count);
            }
          }
        } catch {}
      }

      if (!saved) {
        // Browser download fallback
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${id}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.gtSaveStatus.set(`Downloaded ${id}.json (server offline)`);
        this.addLog('INFO', `Benchmark fixture downloaded to browser: ${id}.json`);
      } else {
        this.gtSaveStatus.set(`✓ Saved as ${savedFile}`);
        this.addLog('COMMIT', `Ground truth benchmark stored: datasets/ground_truth/${savedFile}`);
      }

      setTimeout(() => {
        this.exitGtMode();
      }, 1200);
    } catch (err: any) {
      this.gtSaveStatus.set(`Save error: ${err?.message || err}`);
      this.addLog('ERR', `Failed to save ground truth: ${err?.message || err}`);
    }
  }

  /**
   * Renders high-contrast Ground Truth overlay on Viewport A with draggable square corner pins.
   * Adheres strictly to the light industrial theme (square reticles, 12px typography, zero neons).
   */
  private drawGroundTruthOverlay(ctx: CanvasRenderingContext2D): void {
    const corners = this.gtCorners();
    const edges = this.gtEdges();
    const state = this.livePieceState();
    if (!corners || corners.length < 4 || !state) return;

    // 1. Stage Frame Reticle
    if (this.showReticle()) {
      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(0.5, 0.5, 383, 383);
    }

    // 2. Raw Piece Contour Boundary (subtle neutral line for snapping reference)
    if (state.contourPoints && state.contourPoints.length > 2) {
      ctx.beginPath();
      ctx.strokeStyle = '#525252';
      ctx.lineWidth = 1.0;
      ctx.moveTo(state.contourPoints[0].x, state.contourPoints[0].y);
      for (let i = 1; i < state.contourPoints.length; i++) {
        ctx.lineTo(state.contourPoints[i].x, state.contourPoints[i].y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // 3. Ground-Truth Boundary Quad (1px dashed monochrome)
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) {
      ctx.lineTo(corners[i].x, corners[i].y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 4. Edge Midpoint Badges (E0..E3)
    ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
    for (let i = 0; i < 4; i++) {
      const c1 = corners[i];
      const c2 = corners[(i + 1) % 4];
      const midX = (c1.x + c2.x) / 2;
      const midY = (c1.y + c2.y) / 2;
      const edgeType = edges[i] || 'Tab';

      const toCX = midX - state.center.x;
      const toCY = midY - state.center.y;
      const dist = Math.hypot(toCX, toCY) || 1.0;
      const badgeX = Math.round(midX + (toCX / dist) * 18);
      const badgeY = Math.round(midY + (toCY / dist) * 18);

      const label = `E${i}:${edgeType.toUpperCase()}`;
      const tw = ctx.measureText(label).width;
      const bw = tw + 8;
      const bh = 18;

      ctx.fillStyle = '#111111';
      ctx.fillRect(Math.round(badgeX - bw / 2), Math.round(badgeY - bh / 2), bw, bh);

      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(Math.round(badgeX - bw / 2) + 0.5, Math.round(badgeY - bh / 2) + 0.5, bw - 1, bh - 1);

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, badgeX, badgeY);
    }

    // 5. Interactive Square Corner Pins (C0..C3)
    const dragIdx = this.draggingCornerIdx();
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      const isDragging = dragIdx === i;
      const cx = Math.round(c.x);
      const cy = Math.round(c.y);

      // Square reticle (10x10)
      ctx.fillStyle = isDragging ? '#111111' : '#ffffff';
      ctx.fillRect(cx - 5, cy - 5, 10, 10);
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx - 4.5, cy - 4.5, 9, 9);

      // Center square pip
      ctx.fillStyle = isDragging ? '#ffffff' : '#111111';
      ctx.fillRect(cx - 1, cy - 1, 2, 2);

      // Corner label badge C0..C3 offset outward
      const toCX = c.x - state.center.x;
      const toCY = c.y - state.center.y;
      const dist = Math.hypot(toCX, toCY) || 1.0;
      const tagX = Math.round(c.x + (toCX / dist) * 20);
      const tagY = Math.round(c.y + (toCY / dist) * 20);

      ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = '#111111';
      ctx.fillRect(tagX - 12, tagY - 9, 24, 18);
      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(tagX - 11.5, tagY - 8.5, 23, 17);

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`C${i}`, tagX, tagY);
    }

    // 6. Top Inverted Status Bar
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, 384, 24);
    ctx.strokeStyle = '#d4d4d4';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(0, 24.5); ctx.lineTo(384, 24.5); ctx.stroke();

    ctx.fillStyle = '#f5f5f5';
    ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillText('GROUND TRUTH BENCHMARK · DRAG C0-C3 · [SPACE] TO SAVE', 8, 12);
  }
}
