import { Injectable, inject } from '@angular/core';
import { AppModeStore } from '../state/app-mode.store';

@Injectable({
  providedIn: 'root'
})
export class KeyboardNavService {
  private readonly appModeStore = inject(AppModeStore);

  init(): void {
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      // Global Command Palette toggle: Ctrl+K or Cmd+K
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.appModeStore.toggleCommandPalette();
        return;
      }

      // Close transient UI on Escape
      if (event.key === 'Escape') {
        if (this.appModeStore.isCommandPaletteOpen()) {
          event.preventDefault();
          this.appModeStore.closeCommandPalette();
          return;
        }
      }

      // Don't intercept when user is typing into input fields
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) {
        return;
      }

      // Mode switching via Alt+1, Alt+2, Alt+3, Alt+4
      if (event.altKey) {
        switch (event.code) {
          case 'Digit1':
          case 'Key1':
            event.preventDefault();
            this.appModeStore.setMode('POSTER');
            return;

          case 'Digit2':
          case 'Key2':
            event.preventDefault();
            this.appModeStore.setMode('OPTICS');
            return;

          case 'Digit3':
          case 'Key3':
            event.preventDefault();
            this.appModeStore.setMode('INGESTION');
            return;

          case 'Digit4':
          case 'Key4':
            event.preventDefault();
            this.appModeStore.setMode('WORKBENCH');
            return;

          case 'KeyB':
            if (['OPTICS', 'INGESTION', 'WORKBENCH'].includes(this.appModeStore.activeMode())) {
              event.preventDefault();
              this.appModeStore.toggleLeftRail();
              return;
            }
            break;
        }
      }

      // Single-key shortcut 'B' for workbench rail toggle (when not typing in inputs)
      if (event.key.toLowerCase() === 'b' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (this.appModeStore.activeMode() === 'WORKBENCH') {
          event.preventDefault();
          this.appModeStore.toggleLeftRail();
          return;
        }
      }

      // Space bar: trigger piece drop scan when in INGESTION mode
      if (event.code === 'Space' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (this.appModeStore.activeMode() === 'INGESTION') {
          event.preventDefault();
          const scanBtn = document.getElementById('scan-drop-btn') as HTMLButtonElement | null;
          if (scanBtn && !scanBtn.disabled) {
            scanBtn.click();
          }
          return;
        }
      }
    });
  }
}
