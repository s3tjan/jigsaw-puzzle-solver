import { Injectable, inject } from '@angular/core';
import { AppModeStore } from '../state/app-mode.store';

@Injectable({
  providedIn: 'root'
})
export class KeyboardNavService {
  private readonly appModeStore = inject(AppModeStore);

  init(): void {
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      // Don't intercept when user is typing into input fields
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) {
        return;
      }

      switch (event.key) {
        case 'F1':
          event.preventDefault();
          this.appModeStore.setMode('INGESTION');
          break;

        case 'F2':
          event.preventDefault();
          this.appModeStore.setMode('POSTER_STUDIO');
          break;

        case 'F3':
          event.preventDefault();
          this.appModeStore.setMode('WORKBENCH');
          break;

        // Visual anti-crowding toggle in Workbench HUD: [Tab] or [b]/[B]
        case 'Tab':
          if (this.appModeStore.activeMode() === 'WORKBENCH') {
            event.preventDefault();
            this.appModeStore.toggleLeftRail();
          }
          break;

        case 'b':
        case 'B':
          if (this.appModeStore.activeMode() === 'WORKBENCH') {
            event.preventDefault();
            this.appModeStore.toggleLeftRail();
          }
          break;
      }
    });
  }
}
