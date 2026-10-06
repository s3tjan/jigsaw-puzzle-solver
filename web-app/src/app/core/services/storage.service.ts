import { Injectable } from '@angular/core';
import { PieceModel, PlacedBoardSlot } from '../models/piece.model';

const DB_NAME = 'JigsawSolverDB';
const DB_VERSION = 1;

@Injectable({
  providedIn: 'root',
})
export class StorageService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains('pieces')) {
            const pieceStore = db.createObjectStore('pieces', { keyPath: 'id' });
            pieceStore.createIndex('timestamp', 'timestamp', { unique: false });
            pieceStore.createIndex('status', 'status', { unique: false });
            pieceStore.createIndex('classification', 'classification', { unique: false });
            pieceStore.createIndex('piece_number', 'piece_number', { unique: true });
          }
          if (!db.objectStoreNames.contains('board_slots')) {
            db.createObjectStore('board_slots', { keyPath: 'slot_key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  async getAllPieces(): Promise<PieceModel[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pieces', 'readonly');
      const store = tx.objectStore('pieces');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async savePiece(piece: PieceModel): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pieces', 'readwrite');
      const store = tx.objectStore('pieces');
      const req = store.put(piece);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async deletePiece(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pieces', 'readwrite');
      const store = tx.objectStore('pieces');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async getAllPlacedSlots(): Promise<PlacedBoardSlot[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('board_slots', 'readonly');
      const store = tx.objectStore('board_slots');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async savePlacedSlot(slot: PlacedBoardSlot): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('board_slots', 'readwrite');
      const store = tx.objectStore('board_slots');
      const req = store.put(slot);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async removePlacedSlot(slotKey: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('board_slots', 'readwrite');
      const store = tx.objectStore('board_slots');
      const req = store.delete(slotKey);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
