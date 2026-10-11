import { Injectable, signal } from '@angular/core';

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export function isInternalCamera(label: string): boolean {
  const l = (label || '').toLowerCase().trim();
  return /integrated|internal|builtin|built-in|facetime|front|laptop/i.test(l);
}

export function isExternalCamera(label: string): boolean {
  const l = (label || '').toLowerCase().trim();
  if (!l || isInternalCamera(l)) return false;
  return true;
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
   * Refreshes list of video input devices and prioritizes external USB cameras
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

      const externalDevices = videoDevices.filter(d => isExternalCamera(d.label));
      const savedDeviceId = localStorage.getItem('jps_active_camera_id');
      const savedDevice = videoDevices.find(d => d.deviceId === savedDeviceId);
      const savedIsInternal = savedDevice && isInternalCamera(savedDevice.label);

      // If an external camera is present, ALWAYS prioritize it over any internal laptop webcam
      if (externalDevices.length > 0) {
        if (savedDevice && !savedIsInternal) {
          this.selectedDeviceId.set(savedDevice.deviceId);
        } else {
          // Default to the first external camera
          const chosen = externalDevices[0];
          this.selectedDeviceId.set(chosen.deviceId);
          localStorage.setItem('jps_active_camera_id', chosen.deviceId);
        }
      } else if (savedDevice) {
        this.selectedDeviceId.set(savedDevice.deviceId);
      } else if (videoDevices.length > 0) {
        this.selectedDeviceId.set(videoDevices[0].deviceId);
      }

      return videoDevices;
    } catch (err) {
      console.warn('CameraService: Failed to enumerate video devices', err);
      return [];
    }
  }

  /**
   * Switches the active camera device, persists to localStorage, and restarts the stream
   */
  async switchDevice(deviceId: string, videoElement?: HTMLVideoElement): Promise<MediaStream | null> {
    this.selectedDeviceId.set(deviceId);
    localStorage.setItem('jps_active_camera_id', deviceId);
    if (this.isStreaming() || videoElement) {
      return this.startStream(videoElement, deviceId, true);
    }
    return null;
  }

  /**
   * Requests 1080p stream with graceful fallback to 720p or default resolution,
   * verifying that external camera is used instead of integrated laptop webcam.
   */
  async startStream(videoElement?: HTMLVideoElement, deviceId?: string, isExplicitSwitch: boolean = false): Promise<MediaStream | null> {
    this.stopStream();
    this.error.set(null);

    let targetDeviceId = deviceId || this.selectedDeviceId();

    // If no explicit device was requested, refresh devices to see if an external sensor is already known
    if (!targetDeviceId) {
      const devList = await this.refreshDevices();
      const ext = devList.find(d => isExternalCamera(d.label));
      if (ext) {
        targetDeviceId = ext.deviceId;
        this.selectedDeviceId.set(ext.deviceId);
      }
    }

    let stream: MediaStream | null = null;

    // 1. Try 1080p target first
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        },
        audio: false
      });
    } catch (err1080) {
      console.warn('CameraService: 1080p request failed, falling back to 720p', err1080);
    }

    // 2. Fallback to 720p
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
      } catch (err720) {
        console.warn('CameraService: 720p request failed, falling back to standard resolution', err720);
      }
    }

    // 3. Fallback to standard constraint
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: targetDeviceId ? { deviceId: { exact: targetDeviceId } } : true,
          audio: false
        });
      } catch (errFinal: any) {
        const msg = errFinal?.message || 'Failed to acquire camera stream';
        this.error.set(msg);
        this.isStreaming.set(false);
        return null;
      }
    }

    // Inspect acquired stream track
    const track = stream.getVideoTracks()[0];
    const trackLabel = track?.label || '';

    // If this wasn't a deliberate user override, refresh devices with permissions granted
    // and verify that we are not streaming the integrated webcam when an external camera is plugged in
    if (!isExplicitSwitch) {
      const freshDevices = await this.refreshDevices();
      if (isInternalCamera(trackLabel)) {
        const extDev = freshDevices.find(d => isExternalCamera(d.label));
        if (extDev && extDev.deviceId !== track.getSettings().deviceId) {
          console.info(`CameraService: Re-routing stream from laptop webcam (${trackLabel}) to external sensor (${extDev.label})`);
          for (const t of stream.getTracks()) t.stop();
          this.selectedDeviceId.set(extDev.deviceId);
          localStorage.setItem('jps_active_camera_id', extDev.deviceId);
          return this.startStream(videoElement, extDev.deviceId, true);
        }
      }
    }

    return this.attachStream(stream, videoElement);
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

  getStream(): MediaStream | null {
    return this.mediaStream;
  }

  attachVideo(videoElement: HTMLVideoElement): void {
    if (this.mediaStream) {
      videoElement.srcObject = this.mediaStream;
      videoElement.play().catch(e => console.warn('CameraService: video play() error', e));
    }
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
