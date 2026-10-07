import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PosterStore } from '../../core/state/poster.store';
import { PosterCanvasComponent } from './poster-canvas.component';
import { TrayId, TrayInfo } from '../../core/models/poster.model';

@Component({
  selector: 'app-tray-studio',
  standalone: true,
  imports: [CommonModule, FormsModule, PosterCanvasComponent],
  templateUrl: './tray-studio.component.html',
  styleUrl: './tray-studio.component.css'
})
export class TrayStudioComponent {
  readonly posterStore = inject(PosterStore);

  @ViewChild('fileInput') private readonly fileInput!: ElementRef<HTMLInputElement>;

  triggerFileUpload(): void {
    this.fileInput.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        this.posterStore.loadPosterImage(img);
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  onWeightChange(key: 'wColor' | 'wTexture' | 'wSpatial', event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.posterStore.setWeight(key, val);
  }

  recluster(): void {
    this.posterStore.recluster();
  }

  toggleSolo(trayId: TrayId): void {
    this.posterStore.setSoloTray(trayId);
  }

  resetToCalibration(): void {
    this.posterStore.initDefaultPoster();
  }
}
