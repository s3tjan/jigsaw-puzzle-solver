import { ApplicationConfig, provideZoneChangeDetection, inject, provideAppInitializer } from '@angular/core';
import { WasmEngineService } from './core/services/wasm-engine.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideAppInitializer(() => {
      const wasm = inject(WasmEngineService);
      return wasm.initWasm();
    })
  ]
};

