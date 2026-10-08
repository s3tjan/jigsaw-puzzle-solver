import { Injectable, signal } from '@angular/core';

export interface TrayBucket {
  id: number;
  name: string;
  count: number;
  maxCapacity: number;
}

@Injectable({
  providedIn: 'root'
})
export class InventoryStore {
  readonly maxTrayCapacity = 125;

  readonly trays = signal<TrayBucket[]>([
    { id: 1, name: 'MEADOW', count: 110, maxCapacity: 125 },
    { id: 2, name: 'SKY', count: 104, maxCapacity: 125 },
    { id: 3, name: 'BRICK', count: 96, maxCapacity: 125 },
    { id: 4, name: 'STONE', count: 95, maxCapacity: 125 },
    { id: 5, name: 'FOREST', count: 118, maxCapacity: 125 },
    { id: 6, name: 'EARTH', count: 108, maxCapacity: 125 },
    { id: 7, name: 'CANOPY', count: 102, maxCapacity: 125 },
    { id: 8, name: 'SHADOW', count: 90, maxCapacity: 125 }
  ]);

  readonly totalIngested = signal<number>(823);
  readonly targetTotal = 1008;
}
