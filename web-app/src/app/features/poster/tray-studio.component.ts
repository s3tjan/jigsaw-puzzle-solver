import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PosterStore } from '../../core/state/poster.store';
import { PosterCanvasComponent } from './poster-canvas.component';
import { ClusteringWeights, TrayId } from '../../core/models/poster.model';

export interface WeightConfig {
  key: keyof ClusteringWeights;
  label: string;
}

@Component({
  selector: 'app-tray-studio',
  standalone: true,
  imports: [CommonModule, FormsModule, PosterCanvasComponent],
  templateUrl: './tray-studio.component.html',
  styleUrl: './tray-studio.component.css'
})
export class TrayStudioComponent {
  readonly posterStore = inject(PosterStore);

  readonly weightConfigs: readonly WeightConfig[] = [
    { key: 'wColor', label: 'COLOR (CIELAB)' },
    { key: 'wTexture', label: 'TEXTURE (GRADIENT)' },
    { key: 'wSpatial', label: 'POSITION (GRID)' }
  ];

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

  onWeightChange(key: keyof ClusteringWeights, event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    this.posterStore.setWeight(key, val);
  }

  toggleSolo(trayId: TrayId): void {
    this.posterStore.setSoloTray(trayId);
  }

  resetToCalibration(): void {
    this.posterStore.initDefaultPoster();
  }
}
