import { Injectable } from '@angular/core';

export interface StoredPiece {
  id: number;
  trayId: number;
  timestamp: number;
  polarities: [string, string, string, string]; // [N, E, S, W]
  tabWidthMm: number;
  confidence: number;
  // Normalized contour coordinates (in mm or unit scale)
  contourPoints?: [number, number][];
  // 4 edges x 100 normalized baseline profile points for FCQL matching
  normalizedProfiles?: number[][];
  meanLab?: [number, number, number];
  // Data URL thumbnail of the piece
  thumbnailDataUrl?: string;
}

export interface OpticalCalibration {
  corners: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  lensK1: number;
  sensitivity: number;
}

export const DEFAULT_OPTICAL_CALIBRATION: OpticalCalibration = {
  corners: [
    { x: 120, y: 80 },
    { x: 520, y: 80 },
    { x: 520, y: 400 },
    { x: 120, y: 400 }
  ],
  lensK1: 0.0,
  sensitivity: 25.0
};

export interface StoredPoster {
  id: string; // 'current_poster'
  timestamp: number;
  weights: { wColor: number; wTexture: number; wSpatial: number };
  imageDataUrl?: string;
  slots: any[];
  trays: any[];
  stats: any;
}

const DB_NAME = 'jigsaw_puzzle_db';
const DB_VERSION = 2;
const STORE_PIECES = 'pieces';
const STORE_POSTER = 'poster';
const STORE_METADATA = 'metadata';

@Injectable({
  providedIn: 'root'
})
export class StorageService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_PIECES)) {
          const pieceStore = db.createObjectStore(STORE_PIECES, { keyPath: 'id' });
          pieceStore.createIndex('trayId', 'trayId', { unique: false });
          pieceStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_POSTER)) {
          db.createObjectStore(STORE_POSTER, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  /**
   * Saves or updates the calibrated poster state in IndexedDB
   */
  async savePoster(poster: StoredPoster): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_POSTER, 'readwrite');
      const store = tx.objectStore(STORE_POSTER);
      const req = store.put(poster);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves the current calibrated poster state from IndexedDB
   */
  async getPoster(): Promise<StoredPoster | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_POSTER, 'readonly');
      const store = tx.objectStore(STORE_POSTER);
      const req = store.get('current_poster');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Saves or updates a digitized piece in IndexedDB
   */
  async savePiece(piece: StoredPiece): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PIECES, 'readwrite');
      const store = tx.objectStore(STORE_PIECES);
      const req = store.put(piece);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Deletes a piece from IndexedDB by ID
   */
  async deletePiece(pieceId: number): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PIECES, 'readwrite');
      const store = tx.objectStore(STORE_PIECES);
      const req = store.delete(pieceId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves a single stored piece by ID from IndexedDB
   */
  async getPiece(pieceId: number): Promise<StoredPiece | undefined> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PIECES, 'readonly');
      const store = tx.objectStore(STORE_PIECES);
      const req = store.get(pieceId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves all stored pieces from IndexedDB
   */
  async getAllPieces(): Promise<StoredPiece[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PIECES, 'readonly');
      const store = tx.objectStore(STORE_PIECES);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieves pieces belonging to a specific tray
   */
  async getPiecesByTray(trayId: number): Promise<StoredPiece[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PIECES, 'readonly');
      const store = tx.objectStore(STORE_PIECES);
      const index = store.index('trayId');
      const req = index.getAll(trayId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Counts total pieces in IndexedDB
   */
  async getPieceCount(): Promise<number> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_PIECES, 'readonly');
      const store = tx.objectStore(STORE_PIECES);
      const req = store.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Clears all pieces (for reset / calibration)
   */
  async clearAllPieces(): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_PIECES, STORE_METADATA], 'readwrite');
      tx.objectStore(STORE_PIECES).clear();
      tx.objectStore(STORE_METADATA).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieves optical calibration parameters (homography corners, lens K1, binarization sensitivity)
   */
  getOpticalCalibration(): OpticalCalibration {
    try {
      const savedCorners = localStorage.getItem('jigsaw_calibration_corners_v3');
      const savedK1 = localStorage.getItem('jigsaw_k1');
      const savedSens = localStorage.getItem('jigsaw_sensitivity');

      return {
        corners: savedCorners && Array.isArray(JSON.parse(savedCorners)) && JSON.parse(savedCorners).length === 4
          ? JSON.parse(savedCorners)
          : [...DEFAULT_OPTICAL_CALIBRATION.corners],
        lensK1: savedK1 ? parseFloat(savedK1) || 0.0 : DEFAULT_OPTICAL_CALIBRATION.lensK1,
        sensitivity: savedSens ? parseFloat(savedSens) || 25.0 : DEFAULT_OPTICAL_CALIBRATION.sensitivity,
      };
    } catch {
      return { ...DEFAULT_OPTICAL_CALIBRATION };
    }
  }

  /**
   * Persists optical calibration parameters
   */
  saveOpticalCalibration(cal: OpticalCalibration): void {
    try {
      localStorage.setItem('jigsaw_calibration_corners_v3', JSON.stringify(cal.corners));
      localStorage.setItem('jigsaw_k1', cal.lensK1.toString());
      localStorage.setItem('jigsaw_sensitivity', cal.sensitivity.toString());
    } catch { }
  }
}
