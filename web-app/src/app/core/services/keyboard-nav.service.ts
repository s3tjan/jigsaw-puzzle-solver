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

      if (event.altKey) {
        switch (event.code) {
          case 'Digit1':
          case 'Key1':
            event.preventDefault();
            this.appModeStore.setMode('INGESTION');
            return;

          case 'Digit2':
          case 'Key2':
            event.preventDefault();
            this.appModeStore.setMode('POSTER_STUDIO');
            return;

          case 'Digit3':
          case 'Key3':
            event.preventDefault();
            this.appModeStore.setMode('WORKBENCH');
            return;
        }
      }

      // Visual anti-crowding toggle in Workbench HUD: [Tab]
      if (event.key === 'Tab' && this.appModeStore.activeMode() === 'WORKBENCH') {
        event.preventDefault();
        this.appModeStore.toggleLeftRail();
      }
    });
  }
}
