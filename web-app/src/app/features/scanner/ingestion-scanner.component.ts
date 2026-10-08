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

  @ViewChild('videoRef') videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('captureCanvas') captureCanvas!: ElementRef<HTMLCanvasElement>;

  // Peripheral color flash state for eyes-free sorting feedback (TRY-05 & ING-03)
  readonly activeFlashColor = signal<string | null>(null);
  readonly flashMessage = signal<string | null>(null);

  // Ingestion stats
  readonly lastPiece = signal<StoredPiece | null>(null);
  readonly isProcessing = signal<boolean>(false);
  private flashTimeout: any = null;

  async ngOnInit(): Promise<void> {
    await this.cameraService.refreshDevices();
    await this.cameraService.startStream(this.videoRef?.nativeElement);
  }

  ngOnDestroy(): void {
    this.cameraService.stopStream();
    if (this.flashTimeout) clearTimeout(this.flashTimeout);
  }

  async retryCamera(): Promise<void> {
    await this.cameraService.startStream(this.videoRef?.nativeElement);
  }

  /**
   * Manual trigger / drop consensus simulator for continuous mat piece ingestion
   */
  async triggerScan(): Promise<void> {
    if (this.isProcessing()) return;

    const video = this.videoRef?.nativeElement;
    if (!video || !this.cameraService.isStreaming()) return;

    this.isProcessing.set(true);

    const frameCanvas = this.cameraService.captureFrame(video);
    if (!frameCanvas) {
      this.isProcessing.set(false);
      return;
    }

    // Generate new piece ID based on current total ingested
    const pieceId = this.inventoryStore.totalIngested() + 1;

    // Determine target tray (1..8)
    const trays = this.posterStore.trays();
    const targetTrayId = ((pieceId % 8) + 1) as TrayId;
    const assignedTray = trays.find(t => t.id === targetTrayId);
    const trayColor = assignedTray ? assignedTray.color : '#15803d';

    const polarities: [string, string, string, string] = [
      (pieceId % 2 === 0) ? 'TAB' : 'HOLE',
      'TAB',
      (pieceId % 3 === 0) ? 'HOLE' : 'TAB',
      'FLAT'
    ];

    const piece: StoredPiece = {
      id: pieceId,
      trayId: targetTrayId,
      timestamp: Date.now(),
      polarities,
      tabWidthMm: 4.80 + (pieceId % 5) * 0.02,
      confidence: 0.94,
      thumbnailDataUrl: frameCanvas.toDataURL('image/jpeg', 0.8)
    };

    await this.storageService.savePiece(piece);
    this.lastPiece.set(piece);

    // Update InventoryStore reactive signals
    this.inventoryStore.totalIngested.update(c => c + 1);

    // Trigger whole-screen peripheral color flash (ING-03)
    this.triggerFlash(trayColor, `TRAY-0${targetTrayId} [${assignedTray?.name || 'TRAY'}]`);
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
