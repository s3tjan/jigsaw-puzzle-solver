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
import { WasmEngineService, IngestedPiecePayload, StagedPieceAnalysis } from '../../core/services/wasm-engine.service';
import { TrayId } from '../../core/models/poster.model';

export interface DiagnosticLogEntry {
  timestamp: string;
  severity: 'INFO' | 'CV' | 'DETECT' | 'COMMIT' | 'EDGE' | 'ROUTE' | 'STORE' | 'STAGE' | 'WARN' | 'ERR';
  message: string;
}

export interface EdgeDetail {
  index: number;
  name: string;
  direction: 'N' | 'E' | 'S' | 'W';
  polarity: 'TAB' | 'HOLE' | 'FLAT';
  depthMm: number;
  chordLengthMm: number;
  startCorner: { x: number; y: number };
  endCorner: { x: number; y: number };
  midPoint: { x: number; y: number };
  curvePoints: Array<{ x: number; y: number }>;
  normalizedProfile?: number[];
}

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

export interface TemporalFilterState {
  center: { x: number; y: number };
  corners: Array<{ x: number; y: number }>;
  rotationAngleDeg: number;
  boundingWidthMm: number;
  boundingHeightMm: number;
  perimeterMm: number;
  areaMm2: number;
  tabWidthMm: number;
  meanLab: [number, number, number];
  meanRgb: [number, number, number];
  textureGradient: number;
  colorStd: number;
  chroma: number;
  depthsMm: number[];
  chordsMm: number[];
  stableTrayId: number;
  candidateTrayId: number;
  candidateFramesCount: number;
  confidence: number;
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

  // Viewport B display mode ('DISSECT' = 4-Quadrant Dissected Edges, 'PROFILES' = Baseline Curves, 'MASK' = Otsu Binary Mask)
  readonly viewBMode = signal<'DISSECT' | 'PROFILES' | 'MASK'>('DISSECT');

  private filterState: TemporalFilterState | null = null;

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

  private animFrameId: number | null = null;
  private lastDewarpedBuffer: Uint8Array | null = null;
  private lastLiveEvalTime: number = 0;
  private wasPiecePresentLastFrame: boolean = false;

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
            this.captureCurrentPiece();
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
        this.selectedPiece.set(last);
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

      // Continuous live CV evaluation (throttled to ~15 FPS / 65ms for peak responsiveness)
      const now = performance.now();
      if (now - this.lastLiveEvalTime >= 65 && !this.isProcessing()) {
        this.lastLiveEvalTime = now;
        this.evaluateLiveStage(dewarped);
      }
    }

    this.drawStageOverlay();
    this.drawDiagnosticsCanvas();
  }

  /**
   * Live CV evaluation: continuously detects piece on mat, computes contours,
   * edge classifications, geometry, and real-time routing recommendations.
   */
  private evaluateLiveStage(dewarped: Uint8Array): void {
    const analysis = this.wasmEngine.analyzeStagedPiece(dewarped, 384, 384, this.sensitivity());

    if (!analysis || !analysis.piece || analysis.fgPixels < 600) {
      if (this.wasPiecePresentLastFrame) {
        this.addLog('STAGE', 'Stage arena cleared. Awaiting piece on mat.');
        this.wasPiecePresentLastFrame = false;
        this.filterState = null;
      }
      this.livePieceDetected.set(false);
      this.livePieceState.set(null);
      return;
    }

    const piece = analysis.piece;
    const pxToMm = 25.0 / 96.0;

    // 1. Raw geometry measurements
    const rawCenter = { x: piece.center.x, y: piece.center.y };
    const rawRotationAngleDeg = (piece.rotation_angle_rad * 180.0 / Math.PI);
    const rawBoundingWidthMm = piece.bounding_width * pxToMm;
    const rawBoundingHeightMm = piece.bounding_height * pxToMm;
    const rawPerimeterMm = piece.perimeter_length * pxToMm;
    const rawAreaMm2 = analysis.fgPixels * pxToMm * pxToMm;

    // 2. Contour points conversion
    const contourPoints: Array<{ x: number; y: number }> = (piece.contour_points || []).map((p: any) => ({
      x: p.x, y: p.y
    }));

    // 3. Raw corners conversion
    const rawCorners: Array<{ x: number; y: number }> = (piece.corners || []).map((c: any) => ({
      x: c.x, y: c.y
    }));

    // 4. Edges conversion & physical depth metrics
    const edgeNames = ['NORTH (E0)', 'EAST (E1)', 'SOUTH (E2)', 'WEST (E3)'];
    const directions: Array<'N' | 'E' | 'S' | 'W'> = ['N', 'E', 'S', 'W'];
    const rawEdges: EdgeDetail[] = [];
    let tabWidthSum = 0;
    let tabCount = 0;

    for (let i = 0; i < 4; i++) {
      const e = piece.edges ? piece.edges[i] : null;
      if (!e) continue;

      const cStart = { x: e.start_corner.x, y: e.start_corner.y };
      const cEnd = { x: e.end_corner.x, y: e.end_corner.y };
      const chordDx = cEnd.x - cStart.x;
      const chordDy = cEnd.y - cStart.y;
      const chordLenPx = Math.sqrt(chordDx * chordDx + chordDy * chordDy);
      const chordLenMm = chordLenPx * pxToMm;

      const midX = (cStart.x + cEnd.x) / 2;
      const midY = (cStart.y + cEnd.y) / 2;

      let nx = -chordDy / (chordLenPx || 1);
      let ny = chordDx / (chordLenPx || 1);
      if ((midX + nx - rawCenter.x) * nx + (midY + ny - rawCenter.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }

      const polStr = String(e.edge_type).toUpperCase();
      const polarity: 'TAB' | 'HOLE' | 'FLAT' =
        polStr.includes('TAB') ? 'TAB' : polStr.includes('HOLE') ? 'HOLE' : 'FLAT';

      let depthMm = Math.abs(e.curvature_depth) * pxToMm;
      if (polarity === 'HOLE') depthMm = -depthMm;
      if (polarity === 'FLAT') depthMm = 0.0;

      if (polarity === 'TAB' || polarity === 'HOLE') {
        const tw = (chordLenPx * 0.32) * pxToMm;
        tabWidthSum += tw;
        tabCount++;
      }

      const curvePoints: Array<{ x: number; y: number }> = (e.curve_samples || []).map((p: any) => ({
        x: p.x, y: p.y
      }));

      rawEdges.push({
        index: i,
        name: edgeNames[i],
        direction: directions[i],
        polarity,
        depthMm,
        chordLengthMm: chordLenMm,
        startCorner: cStart,
        endCorner: cEnd,
        midPoint: { x: midX + nx * 14, y: midY + ny * 14 },
        curvePoints,
        normalizedProfile: e.normalized_profile
      });
    }

    const rawTabWidthMm = tabCount > 0 ? (tabWidthSum / tabCount) : 4.80;

    // 5. Sample Full Foreground CIELAB, Color Variance, and Sobel Gradient
    const bW = Math.max(24, Math.round(piece.bounding_width));
    const bH = Math.max(24, Math.round(piece.bounding_height));
    const minX = Math.max(1, Math.floor(rawCenter.x - bW * 0.55));
    const maxX = Math.min(382, Math.ceil(rawCenter.x + bW * 0.55));
    const minY = Math.max(1, Math.floor(rawCenter.y - bH * 0.55));
    const maxY = Math.min(382, Math.ceil(rawCenter.y + bH * 0.55));

    let sumR = 0, sumG = 0, sumB = 0;
    let sumSqR = 0, sumSqG = 0, sumSqB = 0;
    let count = 0;
    let chromSumL = 0, chromSumA = 0, chromSumB = 0;
    let chromCount = 0;
    let gradSum = 0, gradCount = 0;

    const mask = analysis.binaryMask;
    for (let py = minY; py <= maxY; py += 2) {
      for (let px = minX; px <= maxX; px += 2) {
        const maskIdx = py * 384 + px;
        if (mask && mask[maskIdx] > 128) {
          const idx = maskIdx * 4;
          const rPix = dewarped[idx];
          const gPix = dewarped[idx + 1];
          const bPix = dewarped[idx + 2];
          sumR += rPix;
          sumG += gPix;
          sumB += bPix;
          sumSqR += rPix * rPix;
          sumSqG += gPix * gPix;
          sumSqB += bPix * bPix;
          count++;

          const [pl, pa, pb] = this.rgbToLab(rPix, gPix, bPix);
          const pChroma = Math.hypot(pa, pb);
          if (pChroma >= 14.0) {
            chromSumL += pl;
            chromSumA += pa;
            chromSumB += pb;
            chromCount++;
          }

          const idxL = (py * 384 + (px - 1)) * 4;
          const idxR = (py * 384 + (px + 1)) * 4;
          const idxU = ((py - 1) * 384 + px) * 4;
          const idxD = ((py + 1) * 384 + px) * 4;
          const lumL = dewarped[idxL] * 0.299 + dewarped[idxL + 1] * 0.587 + dewarped[idxL + 2] * 0.114;
          const lumR = dewarped[idxR] * 0.299 + dewarped[idxR + 1] * 0.587 + dewarped[idxR + 2] * 0.114;
          const lumU = dewarped[idxU] * 0.299 + dewarped[idxU + 1] * 0.587 + dewarped[idxU + 2] * 0.114;
          const lumD = dewarped[idxD] * 0.299 + dewarped[idxD + 1] * 0.587 + dewarped[idxD + 2] * 0.114;
          const gx = (lumR - lumL) * 0.5;
          const gy = (lumD - lumU) * 0.5;
          gradSum += Math.hypot(gx, gy);
          gradCount++;
        }
      }
    }

    const r = count > 0 ? Math.round(sumR / count) : 128;
    const g = count > 0 ? Math.round(sumG / count) : 128;
    const b = count > 0 ? Math.round(sumB / count) : 128;
    const rawLab = this.rgbToLab(r, g, b);

    let rawColorStd = 0.10;
    if (count > 1) {
      const varR = (sumSqR / count) - (sumR / count) ** 2;
      const varG = (sumSqG / count) - (sumG / count) ** 2;
      const varB = (sumSqB / count) - (sumB / count) ** 2;
      const meanVar = Math.sqrt((Math.max(0, varR) + Math.max(0, varG) + Math.max(0, varB)) / 3.0);
      rawColorStd = Math.min(1.0, meanVar / 64.0);
    }
    const rawTextureGrad = gradCount > 0 ? Math.min(1.0, gradSum / (gradCount * 50.0)) : 0.15;

    const hasChromatic = count > 0 && (chromCount / count) >= 0.05;
    const chromLab: [number, number, number] = hasChromatic
      ? [chromSumL / chromCount, chromSumA / chromCount, chromSumB / chromCount]
      : [...rawLab];
    const rawPieceChroma = Math.hypot(chromLab[1], chromLab[2]);

    // Protect chromatic artwork: blend chromatic Lab with mean Lab so that red/artwork is not
    // washed out into neutral grey by white/black backgrounds
    const effectiveLab: [number, number, number] = (hasChromatic && rawPieceChroma >= 15.0)
      ? [
          rawLab[0] * 0.35 + chromLab[0] * 0.65,
          rawLab[1] * 0.30 + chromLab[1] * 0.70,
          rawLab[2] * 0.30 + chromLab[2] * 0.70
        ]
      : [...rawLab];

    // 6. Anti-Wobble Temporal Filter (EMA Smoothing)
    const distFromPrev = this.filterState
      ? Math.hypot(rawCenter.x - this.filterState.center.x, rawCenter.y - this.filterState.center.y)
      : 999;
    const isNewPlacement = !this.filterState || distFromPrev > 20 || !this.wasPiecePresentLastFrame;

    const isBorder = piece.is_border || rawEdges.filter(e => e.polarity === 'FLAT').length === 1;
    const isCorner = piece.is_corner || rawEdges.filter(e => e.polarity === 'FLAT').length >= 2;

    if (isNewPlacement) {
      this.filterState = {
        center: { ...rawCenter },
        corners: rawCorners.map(c => ({ ...c })),
        rotationAngleDeg: rawRotationAngleDeg,
        boundingWidthMm: rawBoundingWidthMm,
        boundingHeightMm: rawBoundingHeightMm,
        perimeterMm: rawPerimeterMm,
        areaMm2: rawAreaMm2,
        tabWidthMm: rawTabWidthMm,
        meanLab: [...effectiveLab] as [number, number, number],
        meanRgb: [r, g, b],
        textureGradient: rawTextureGrad,
        colorStd: rawColorStd,
        chroma: rawPieceChroma,
        depthsMm: rawEdges.map(e => e.depthMm),
        chordsMm: rawEdges.map(e => e.chordLengthMm),
        stableTrayId: (isBorder || isCorner) ? 0 : 1,
        candidateTrayId: (isBorder || isCorner) ? 0 : 1,
        candidateFramesCount: 0,
        confidence: 0.90
      };
    } else {
      const alpha = 0.22;
      const f = this.filterState!;
      f.center.x += (rawCenter.x - f.center.x) * alpha;
      f.center.y += (rawCenter.y - f.center.y) * alpha;

      for (let i = 0; i < 4 && i < rawCorners.length; i++) {
        if (!f.corners[i]) f.corners[i] = { ...rawCorners[i] };
        f.corners[i].x += (rawCorners[i].x - f.corners[i].x) * alpha;
        f.corners[i].y += (rawCorners[i].y - f.corners[i].y) * alpha;
      }

      let dAngle = rawRotationAngleDeg - f.rotationAngleDeg;
      if (dAngle > 180) dAngle -= 360;
      if (dAngle < -180) dAngle += 360;
      f.rotationAngleDeg += dAngle * alpha;

      f.boundingWidthMm += (rawBoundingWidthMm - f.boundingWidthMm) * alpha;
      f.boundingHeightMm += (rawBoundingHeightMm - f.boundingHeightMm) * alpha;
      f.perimeterMm += (rawPerimeterMm - f.perimeterMm) * alpha;
      f.areaMm2 += (rawAreaMm2 - f.areaMm2) * alpha;
      f.tabWidthMm += (rawTabWidthMm - f.tabWidthMm) * alpha;

      f.meanLab[0] += (effectiveLab[0] - f.meanLab[0]) * 0.20;
      f.meanLab[1] += (effectiveLab[1] - f.meanLab[1]) * 0.20;
      f.meanLab[2] += (effectiveLab[2] - f.meanLab[2]) * 0.20;
      f.textureGradient += (rawTextureGrad - f.textureGradient) * 0.20;
      f.colorStd += (rawColorStd - f.colorStd) * 0.20;
      f.chroma += (rawPieceChroma - f.chroma) * 0.20;

      for (let i = 0; i < 4 && i < rawEdges.length; i++) {
        f.depthsMm[i] += (rawEdges[i].depthMm - f.depthsMm[i]) * alpha;
        f.chordsMm[i] += (rawEdges[i].chordLengthMm - f.chordsMm[i]) * alpha;
      }
    }

    const f = this.filterState!;

    // 7. Multi-Factor Tray Routing & Poster Slot Matching
    const centroids = this.posterStore.activeCentroids();
    const trays = this.posterStore.trays();
    const posterSlots = this.posterStore.slots();
    const interiorSlots = posterSlots.filter(s => !s.isBorder && !s.isCorner && s.trayId >= 1);
    const trayRankings: TrayDistanceRanking[] = [];
    let targetTrayId = 0;
    let confidence = 0.98;

    if (isBorder || isCorner) {
      targetTrayId = 0;
      f.stableTrayId = 0;
      f.candidateTrayId = 0;
      confidence = 0.98;

      for (let i = 0; i < centroids.length; i++) {
        const tId = i + 1;
        const tInfo = trays.find(t => t.id === tId);
        trayRankings.push({
          trayId: tId,
          trayName: tInfo?.name || `TRAY-0${tId}`,
          color: tInfo?.color || '#525252',
          distSq: 1.0,
          isAssigned: false
        });
      }
    } else {
      // Slot k-NN voting across poster:
      const slotVotes: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
      let totalVotes = 0;
      if (interiorSlots.length > 0) {
        const slotDists = interiorSlots.map(s => {
          const dl = (f.meanLab[0] - s.lab[0]) * 0.5;
          const da = f.meanLab[1] - s.lab[1];
          const db = f.meanLab[2] - s.lab[2];
          const dColorSq = (dl * dl + da * da + db * db) / 900.0;
          const dGrad = f.textureGradient - s.gradient;
          const dStd = f.colorStd - (s.colorStd ?? 0.10);
          const dTextSq = 0.55 * (dGrad * dGrad) + 0.45 * (dStd * dStd);
          return { trayId: s.trayId as number, distSq: 0.65 * dColorSq + 0.35 * dTextSq };
        });
        slotDists.sort((a, b) => a.distSq - b.distSq);
        const topK = slotDists.slice(0, 15);
        for (const item of topK) {
          const weight = 1.0 / (item.distSq + 0.05);
          slotVotes[item.trayId] = (slotVotes[item.trayId] || 0) + weight;
          totalVotes += weight;
        }
      }

      // Interior piece: match against centroids using smoothed CIELAB & k-NN voting
      let bestDist = Infinity;
      let secondBestDist = Infinity;
      let rawBestTrayId = 1;
      const distances: number[] = [];

      for (let i = 0; i < centroids.length; i++) {
        const c = centroids[i];
        const tId = i + 1;
        const tInfo = trays.find(t => t.id === tId);

        const centChroma = Math.hypot(c.lab[1], c.lab[2]);
        const dl = (f.meanLab[0] - c.lab[0]) * 0.5;
        const da = f.meanLab[1] - c.lab[1];
        const db = f.meanLab[2] - c.lab[2];
        const normColorSq = (dl * dl + da * da + db * db) / 900.0;

        const dGrad = f.textureGradient - c.gradient;
        const dStd = f.colorStd - (c.color_std ?? 0.10);
        const dTextureSq = 0.55 * (dGrad * dGrad) + 0.45 * (dStd * dStd);

        // Achromatic mismatch penalty: prevent chromatic pieces from matching dull grey Stone
        const achromaticPenalty = (f.chroma > 15.0 && centChroma < 8.0) ? 0.35 : 0.0;
        const centDistSq = 0.60 * normColorSq + 0.30 * dTextureSq + achromaticPenalty;

        let distSq = centDistSq;
        if (totalVotes > 0) {
          const voteShare = (slotVotes[tId] || 0) / totalVotes;
          distSq = 0.45 * centDistSq + 0.55 * (1.0 - voteShare);
        }

        distances.push(distSq);

        if (distSq < bestDist) {
          secondBestDist = bestDist;
          bestDist = distSq;
          rawBestTrayId = tId;
        } else if (distSq < secondBestDist) {
          secondBestDist = distSq;
        }

        trayRankings.push({
          trayId: tId,
          trayName: tInfo?.name || `TRAY-0${tId}`,
          color: tInfo?.color || '#525252',
          distSq: Math.round(distSq * 1000) / 1000,
          isAssigned: false
        });
      }

      // On new piece placement: immediately adopt winning tray without delay
      if (isNewPlacement) {
        f.stableTrayId = rawBestTrayId;
        f.candidateTrayId = rawBestTrayId;
        f.candidateFramesCount = 0;
      } else if (f.stableTrayId === 0 || f.stableTrayId === rawBestTrayId) {
        f.stableTrayId = rawBestTrayId;
        f.candidateTrayId = rawBestTrayId;
        f.candidateFramesCount = 0;
      } else {
        if (rawBestTrayId === f.candidateTrayId) {
          f.candidateFramesCount++;
          const currentStableDist = distances[f.stableTrayId - 1] ?? Infinity;
          // Must maintain victory for >= 4 frames with hysteresis margin 0.025
          if (f.candidateFramesCount >= 4 && (bestDist + 0.025 < currentStableDist)) {
            const oldTray = trays.find(t => t.id === f.stableTrayId)?.name || `T-0${f.stableTrayId}`;
            const newTray = trays.find(t => t.id === rawBestTrayId)?.name || `T-0${rawBestTrayId}`;
            this.addLog('ROUTE', `Tray confirmed: ${oldTray} -> ${newTray}`);
            f.stableTrayId = rawBestTrayId;
            f.candidateFramesCount = 0;
          }
        } else {
          f.candidateTrayId = rawBestTrayId;
          f.candidateFramesCount = 1;
        }
      }

      targetTrayId = f.stableTrayId;

      for (const tr of trayRankings) {
        if (tr.trayId === targetTrayId) tr.isAssigned = true;
      }
      trayRankings.sort((a, b) => a.distSq - b.distSq);

      const relMargin = (secondBestDist - bestDist) / (bestDist + secondBestDist + 1e-4);
      const targetConf = 0.60 + 0.38 * Math.min(1.0, Math.max(0.0, relMargin / 0.40));
      f.confidence += (targetConf - f.confidence) * 0.20;
      confidence = Math.round(f.confidence * 100) / 100;
    }

    const assignedTrayInfo = trays.find(t => t.id === targetTrayId);
    const assignedTrayName = targetTrayId === 0
      ? '00 · BORDER & CORNERS'
      : `0${targetTrayId} · ${assignedTrayInfo?.name || 'INTERIOR'}`;
    const assignedTrayColor = targetTrayId === 0 ? '#111111' : (assignedTrayInfo?.color || '#15803d');

    // Combine smoothed edges
    const smoothedEdges: EdgeDetail[] = rawEdges.map((e, idx) => ({
      ...e,
      depthMm: Math.round(f.depthsMm[idx] * 10) / 10,
      chordLengthMm: Math.round(f.chordsMm[idx] * 10) / 10,
      startCorner: f.corners[idx] ? { ...f.corners[idx] } : e.startCorner,
      endCorner: f.corners[(idx + 1) % 4] ? { ...f.corners[(idx + 1) % 4] } : e.endCorner
    }));

    const nextPieceId = this.inventoryStore.totalIngested() + 1;

    const liveState: LivePieceState = {
      pieceIdPreview: nextPieceId,
      center: { x: Math.round(f.center.x * 10) / 10, y: Math.round(f.center.y * 10) / 10 },
      rotationAngleDeg: Math.round(f.rotationAngleDeg * 10) / 10,
      boundingWidthMm: Math.round(f.boundingWidthMm * 10) / 10,
      boundingHeightMm: Math.round(f.boundingHeightMm * 10) / 10,
      perimeterMm: Math.round(f.perimeterMm * 10) / 10,
      areaMm2: Math.round(f.areaMm2 * 10) / 10,
      aspectRatio: f.boundingHeightMm > 0 ? Math.round((f.boundingWidthMm / f.boundingHeightMm) * 100) / 100 : 1.0,
      tabWidthMm: Math.round(f.tabWidthMm * 100) / 100,
      isBorder,
      isCorner,
      fgPixels: analysis.fgPixels,
      thresholdUsed: analysis.thresholdUsed,
      meanRgb: [r, g, b],
      meanLab: [
        Math.round(f.meanLab[0] * 10) / 10,
        Math.round(f.meanLab[1] * 10) / 10,
        Math.round(f.meanLab[2] * 10) / 10
      ],
      textureGradient: Math.round(f.textureGradient * 1000) / 1000,
      edges: smoothedEdges,
      corners: f.corners.map(c => ({ x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 })),
      contourPoints,
      assignedTrayId: targetTrayId,
      assignedTrayName,
      assignedTrayColor,
      confidence,
      trayRankings,
      binaryMask: analysis.binaryMask
    };

    if (!this.wasPiecePresentLastFrame) {
      this.addLog('DETECT', `Live piece detected: Area ${liveState.areaMm2.toFixed(1)}mm² (${analysis.fgPixels}px), Rot ${liveState.rotationAngleDeg > 0 ? '+' : ''}${liveState.rotationAngleDeg.toFixed(1)}°`);
      for (const e of smoothedEdges) {
        const sign = e.depthMm > 0 ? '+' : '';
        this.addLog('EDGE', `${e.name}: ${e.polarity} (chord ${e.chordLengthMm.toFixed(1)}mm, depth ${sign}${e.depthMm.toFixed(1)}mm)`);
      }
      this.addLog('ROUTE', `Routing: ${assignedTrayName} (Conf: ${(liveState.confidence * 100).toFixed(0)}%)`);
      this.wasPiecePresentLastFrame = true;
    }

    this.livePieceDetected.set(true);
    this.livePieceState.set(liveState);
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

    // 2. Continuous Piece Contour
    if (this.showContours() && state.contourPoints.length >= 6) {
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(17, 17, 17, 0.45)';
      ctx.lineWidth = 1.0;
      ctx.moveTo(state.contourPoints[0].x, state.contourPoints[0].y);
      for (let i = 1; i < state.contourPoints.length; i++) {
        ctx.lineTo(state.contourPoints[i].x, state.contourPoints[i].y);
      }
      ctx.closePath();
      ctx.stroke();
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

    // 4. Classified Cardinal Edges (TAB = Green #15803d, HOLE = Amber #b45309, FLAT = Blue #0284c7)
    if (this.showEdges() && state.edges.length > 0) {
      for (const e of state.edges) {
        if (e.curvePoints.length < 2) continue;
        ctx.beginPath();
        ctx.lineWidth = 2.0;
        if (e.polarity === 'TAB') ctx.strokeStyle = '#15803d';
        else if (e.polarity === 'HOLE') ctx.strokeStyle = '#b45309';
        else ctx.strokeStyle = '#0284c7';

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
    } else if (mode === 'PROFILES') {
      // Light industrial surface for waveform visualization
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 384, 384);

      if (state && state.edges.length > 0) {
        // Draw 4 distinct channels (96px height per edge: North, East, South, West)
        const channelHeight = 96;

        for (let i = 0; i < 4; i++) {
          const edge = state.edges[i];
          const topY = i * channelHeight;
          const midY = topY + 52;

          // 1px divider rule between channels
          if (i > 0) {
            ctx.strokeStyle = '#d4d4d4';
            ctx.lineWidth = 1.0;
            ctx.beginPath(); ctx.moveTo(0, topY); ctx.lineTo(384, topY); ctx.stroke();
          }

          // Dashed zero-baseline rule
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#d4d4d4';
          ctx.lineWidth = 1.0;
          ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(384, midY); ctx.stroke();
          ctx.restore();

          // Channel metadata label
          ctx.fillStyle = '#111111';
          ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
          const sign = edge.depthMm > 0 ? '+' : '';
          const depthLabel = edge.polarity === 'FLAT' ? 'FLAT' : `${sign}${edge.depthMm.toFixed(2)}mm`;
          ctx.fillText(`CH${i} [${edge.direction}]: ${edge.polarity} · DEPTH: ${depthLabel} · CHORD: ${edge.chordLengthMm.toFixed(1)}mm`, 8, topY + 16);

          // Plot normalized profile waveform if samples exist
          const profile = edge.normalizedProfile;
          if (profile && profile.length > 0) {
            ctx.beginPath();
            ctx.lineWidth = 2.0;
            if (edge.polarity === 'TAB') ctx.strokeStyle = '#15803d';
            else if (edge.polarity === 'HOLE') ctx.strokeStyle = '#b45309';
            else ctx.strokeStyle = '#0284c7';

            for (let k = 0; k < profile.length; k++) {
              const x = (k / (profile.length - 1)) * 384;
              const y = midY - (profile[k] * 70);
              if (k === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          } else if (edge.curvePoints.length > 1) {
            ctx.beginPath();
            ctx.lineWidth = 2.0;
            if (edge.polarity === 'TAB') ctx.strokeStyle = '#15803d';
            else if (edge.polarity === 'HOLE') ctx.strokeStyle = '#b45309';
            else ctx.strokeStyle = '#0284c7';

            const pts = edge.curvePoints;
            for (let k = 0; k < pts.length; k++) {
              const x = (k / (pts.length - 1)) * 384;
              const y = midY - (edge.depthMm * 4.5);
              if (k === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
        }
      } else {
        // Standby grid
        ctx.strokeStyle = '#e5e5e5';
        ctx.lineWidth = 1.0;
        for (let y = 48; y < 384; y += 48) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(384, y); ctx.stroke();
        }
        for (let x = 48; x < 384; x += 48) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(384, x); ctx.stroke();
        }
        ctx.fillStyle = '#525252';
        ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillText('STANDBY · PLACE PIECE ON MAT TO GRAPH PROFILES', 24, 192);
      }
    } else {
      // MASK mode: render 384x384 binary segmentation mask
      if (state && state.binaryMask && state.binaryMask.length === 384 * 384) {
        const imgData = ctx.createImageData(384, 384);
        const mask = state.binaryMask;
        for (let i = 0; i < mask.length; i++) {
          const val = mask[i] > 128 ? 245 : 30;
          const idx = i * 4;
          imgData.data[idx] = val;
          imgData.data[idx + 1] = val;
          imgData.data[idx + 2] = val;
          imgData.data[idx + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);

        ctx.fillStyle = '#111111';
        ctx.fillRect(0, 0, 384, 24);
        ctx.fillStyle = '#f5f5f5';
        ctx.font = 'bold 12px ui-monospace, Menlo, Consolas, monospace';
        const pct = ((state.fgPixels / (384 * 384)) * 100).toFixed(1);
        ctx.fillText(`OTSU THRESH: ${state.thresholdUsed}/255 · FG: ${state.fgPixels} PX (${pct}%)`, 8, 16);
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
      this.selectedPiece.set(piece);
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
    this.livePieceState.set(null);
    this.livePieceDetected.set(false);
    this.scanStatusMessage.set(null);
    this.filterState = null;
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

  setViewBMode(mode: 'DISSECT' | 'PROFILES' | 'MASK'): void {
    this.viewBMode.set(mode);
    this.drawDiagnosticsCanvas();
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

  private rgbToLab(r: number, g: number, b: number): [number, number, number] {
    let rL = r / 255.0;
    let gL = g / 255.0;
    let bL = b / 255.0;
    rL = rL > 0.04045 ? Math.pow((rL + 0.055) / 1.055, 2.4) : rL / 12.92;
    gL = gL > 0.04045 ? Math.pow((gL + 0.055) / 1.055, 2.4) : gL / 12.92;
    bL = bL > 0.04045 ? Math.pow((bL + 0.055) / 1.055, 2.4) : bL / 12.92;

    const x = (rL * 0.4124 + gL * 0.3576 + bL * 0.1805) / 0.95047;
    const y = (rL * 0.2126 + gL * 0.7152 + bL * 0.0722) / 1.00000;
    const z = (rL * 0.0193 + gL * 0.1192 + bL * 0.9505) / 1.08883;

    const fx = x > 0.008856 ? Math.cbrt(x) : (7.787 * x) + (16.0 / 116.0);
    const fy = y > 0.008856 ? Math.cbrt(y) : (7.787 * y) + (16.0 / 116.0);
    const fz = z > 0.008856 ? Math.cbrt(z) : (7.787 * z) + (16.0 / 116.0);

    const L = (116.0 * fy) - 16.0;
    const a = 500.0 * (fx - fy);
    const bVal = 200.0 * (fy - fz);

    return [
      Math.round(L * 10) / 10,
      Math.round(a * 10) / 10,
      Math.round(bVal * 10) / 10
    ];
  }
}
