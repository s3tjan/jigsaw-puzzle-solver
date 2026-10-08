import { Injectable, signal } from '@angular/core';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

@Injectable({
  providedIn: 'root'
})
export class CameraService {
  private mediaStream: MediaStream | null = null;

  readonly isStreaming = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly availableDevices = signal<CameraDevice[]>([]);
  readonly selectedDeviceId = signal<string | null>(null);
  readonly activeResolution = signal<{ width: number; height: number }>({ width: 0, height: 0 });

  constructor() {
    this.refreshDevices();
  }

  /**
   * Refreshes list of video input devices
   */
  async refreshDevices(): Promise<CameraDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return [];
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices: CameraDevice[] = devices
        .filter(d => d.kind === 'videoinput')
        .map((d, index) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${index + 1}`
        }));

      this.availableDevices.set(videoDevices);
      if (videoDevices.length > 0 && !this.selectedDeviceId()) {
        this.selectedDeviceId.set(videoDevices[0].deviceId);
      }
      return videoDevices;
    } catch (err) {
      console.warn('CameraService: Failed to enumerate video devices', err);
      return [];
    }
  }

  /**
   * Requests 1080p stream with graceful fallback to 720p or default resolution
   */
  async startStream(videoElement?: HTMLVideoElement, deviceId?: string): Promise<MediaStream | null> {
    this.stopStream();
    this.error.set(null);

    const targetDeviceId = deviceId || this.selectedDeviceId();

    // 1. Try 1080p target first
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });
      return this.attachStream(stream, videoElement);
    } catch (err1080) {
      console.warn('CameraService: 1080p request failed, falling back to 720p', err1080);
    }

    // 2. Fallback to 720p
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });
      return this.attachStream(stream, videoElement);
    } catch (err720) {
      console.warn('CameraService: 720p request failed, falling back to any available resolution', err720);
    }

    // 3. Fallback to standard constraint
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: targetDeviceId ? { deviceId: { exact: targetDeviceId } } : true,
        audio: false
      });
      return this.attachStream(stream, videoElement);
    } catch (errFinal: any) {
      const msg = errFinal?.message || 'Failed to acquire camera stream';
      this.error.set(msg);
      this.isStreaming.set(false);
      return null;
    }
  }

  private attachStream(stream: MediaStream, videoElement?: HTMLVideoElement): MediaStream {
    this.mediaStream = stream;
    this.isStreaming.set(true);

    const track = stream.getVideoTracks()[0];
    if (track) {
      const settings = track.getSettings();
      this.activeResolution.set({
        width: settings.width || 0,
        height: settings.height || 0
      });
    }

    if (videoElement) {
      videoElement.srcObject = stream;
      videoElement.play().catch(e => console.warn('CameraService: video play() error', e));
    }

    return stream;
  }

  /**
   * Captures the current video frame onto an HTMLCanvasElement
   */
  captureFrame(video: HTMLVideoElement, targetCanvas?: HTMLCanvasElement): HTMLCanvasElement | null {
    if (!this.isStreaming() || !video.videoWidth || !video.videoHeight) {
      return null;
    }

    const canvas = targetCanvas || document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Stops the active media stream and releases the camera
   */
  stopStream(): void {
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    this.isStreaming.set(false);
    this.activeResolution.set({ width: 0, height: 0 });
  }
}
