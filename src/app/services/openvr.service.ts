import { ApplicationRef, Injectable } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { exit } from '@tauri-apps/api/process';
import { DeviceUpdateEvent } from '../models/events';
import { invoke } from '@tauri-apps/api/tauri';
import { OVRDevice, OVRDevicePose } from '../models/ovr-device';
import { BehaviorSubject, interval, Observable, startWith, Subject, takeUntil } from 'rxjs';
import { cloneDeep, orderBy } from 'lodash';
import { AppSettingsService } from './app-settings.service';
import { error, info } from 'tauri-plugin-log-api';

@Injectable({
  providedIn: 'root',
})
export class OpenVRService {
  private onInitialize$: Subject<void> = new Subject();
  private readonly initStart: number;

  private _devices: BehaviorSubject<OVRDevice[]> = new BehaviorSubject<OVRDevice[]>([]);
  public devices: Observable<OVRDevice[]> = this._devices.asObservable();

  private _devicePoses: BehaviorSubject<{
    [trackingIndex: number]: OVRDevicePose;
  }> = new BehaviorSubject<{ [p: number]: OVRDevicePose }>({});
  public devicePoses: Observable<{ [trackingIndex: number]: OVRDevicePose }> =
    this._devicePoses.asObservable();

  constructor(private appRef: ApplicationRef, private settingsService: AppSettingsService) {
    this.initStart = Date.now();
  }

  async init() {
    interval(2000)
      .pipe(startWith(null), takeUntil(this.onInitialize$))
      .subscribe(async () => {
        const ovrStatus = await invoke('openvr_status');
        switch (ovrStatus) {
          case 'INIT_COMPLETE':
            await this.onOpenVRInit(true);
            break;
          case 'INIT_FAILED':
            await this.onOpenVRInit(false);
            return;
          case 'QUIT':
            await this.onQuitEvent();
            return;
          case 'INITIALIZING':
        }
      });
    await Promise.all([
      listen<DeviceUpdateEvent>('OVR_DEVICE_UPDATE', (event) =>
        this.onDeviceUpdate(event.payload.device)
      ),
      listen<any>('OVR_POSE_UPDATE', (event) => {
        const poses = cloneDeep(this._devicePoses.value);
        const {
          index,
          quaternion,
          position,
        }: {
          index: number;
          quaternion: [number, number, number, number];
          position: [number, number, number];
        } = event.payload;
        poses[index] = { quaternion, position };
        this._devicePoses.next(poses);
        this.appRef.tick();
      }),
      listen<void>('OVR_QUIT', () => this.onQuitEvent()),
      listen<void>('OVR_INIT_COMPLETE', () => {
        this.onOpenVRInit(true);
      }),
      listen<void>('OVR_INIT_FAILED', () => {
        this.onOpenVRInit(false);
      }),
    ]);
  }

  async onOpenVRInit(success: boolean) {
    if (success) {
      info('[OpenVR] OpenVR initialized');
      this.onInitialize$.next();
      const minSplashDuration = 2000;
      const currentSplashDuration = Date.now() - this.initStart;
      const remainingSplashDuration = Math.max(0, minSplashDuration - currentSplashDuration);
      setTimeout(async () => await invoke('close_splashscreen'), remainingSplashDuration);
      this._devices.next(await this.getDevices());
      interval(3000).subscribe(async () => {
        this._devices.next(await this.getDevices());
      });
    }
  }

  onDeviceUpdate(device: OVRDevice) {
    device = Object.assign({}, device);
    if (!device.canPowerOff) device.isTurningOff = false;
    this._devices.next(
      orderBy(
        [device, ...this._devices.value.filter((d) => d.index !== device.index)],
        ['deviceIndex'],
        ['asc']
      )
    );
    this.appRef.tick();
  }

  async onQuitEvent() {
    error('[OpenVR] Quit event detected');
    await exit(0);
  }

  private async getDevices(): Promise<Array<OVRDevice>> {
    // Get devices
    let devices = await invoke<OVRDevice[]>('openvr_get_devices');
    // Carry over current local state
    devices = devices.map((device) => {
      device.isTurningOff =
        this._devices.value.find((d) => d.index === device.index)?.isTurningOff ?? false;
      return device;
    });
    // Return newly fetched devices
    return devices;
  }
}
