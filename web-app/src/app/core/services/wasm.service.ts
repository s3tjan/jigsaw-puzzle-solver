import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class WasmService {
  readonly isLoaded = signal<boolean>(false);
  readonly loadError = signal<string | null>(null);

  private wasmModule: any = null;

  async init(): Promise<void> {
    if (this.wasmModule) return;
    try {
      const wasmJsUrl = '/wasm/cv_engine.js';
      const module = await (Function('url', 'return import(url)')(wasmJsUrl));
      await module.default('/wasm/cv_engine_bg.wasm');
      this.wasmModule = module;
      this.isLoaded.set(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.loadError.set(msg);
      throw err;
    }
  }

  get module(): any {
    return this.wasmModule;
  }
}
