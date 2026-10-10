import { TestBed } from '@angular/core/testing';
import { StorageService, DEFAULT_OPTICAL_CALIBRATION, OpticalCalibration } from './storage.service';

describe('StorageService', () => {
  let service: StorageService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(StorageService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should return default optical calibration when localStorage is empty', () => {
    const cal = service.getOpticalCalibration();
    expect(cal.lensK1).toBe(DEFAULT_OPTICAL_CALIBRATION.lensK1);
    expect(cal.sensitivity).toBe(DEFAULT_OPTICAL_CALIBRATION.sensitivity);
    expect(cal.corners.length).toBe(4);
  });

  it('should persist and retrieve optical calibration parameters', () => {
    const customCal: OpticalCalibration = {
      corners: [
        { x: 100, y: 100 },
        { x: 500, y: 100 },
        { x: 500, y: 500 },
        { x: 100, y: 500 }
      ],
      lensK1: 0.15,
      sensitivity: 32.5
    };

    service.saveOpticalCalibration(customCal);
    const retrieved = service.getOpticalCalibration();

    expect(retrieved.lensK1).toBe(0.15);
    expect(retrieved.sensitivity).toBe(32.5);
    expect(retrieved.corners).toEqual(customCal.corners);
  });
});
