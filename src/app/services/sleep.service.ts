import { Injectable } from '@angular/core';
import {
  BehaviorSubject,
  bufferTime,
  combineLatest,
  distinctUntilChanged,
  filter,
  map,
  merge,
  Observable,
  startWith,
  Subject,
} from 'rxjs';
import { SleepModeStatusChangeReason } from '../models/sleep-mode';
import { SETTINGS_FILE } from '../globals';
import { Store } from 'tauri-plugin-store-api';
import { SleepingPose } from '../models/sleeping-pose';
import { uniq } from 'lodash';
import { OpenVRService } from './openvr.service';
import { OVRDevicePose } from '../models/ovr-device';
import { SleepingPoseDetector } from '../utils/sleeping-pose-detector';
import * as THREE from 'three';
import { info } from 'tauri-plugin-log-api';

export const SETTINGS_KEY_SLEEP_MODE = 'SLEEP_MODE';

@Injectable({
  providedIn: 'root',
})
export class SleepService {
  private store = new Store(SETTINGS_FILE);
  private _mode: BehaviorSubject<boolean | null> = new BehaviorSubject<boolean | null>(null);
  public mode: Observable<boolean> = this._mode.asObservable().pipe(
    filter((v) => v !== null),
    map((v) => v as boolean)
  );
  private poseDetector: SleepingPoseDetector = new SleepingPoseDetector();
  private forcePose$: Subject<SleepingPose> = new Subject<SleepingPose>();

  public pose: Observable<SleepingPose> = merge(
    combineLatest([this.openvr.devices, this.openvr.devicePoses]).pipe(
      map(([devices, poses]) => {
        const hmdDevice = devices.find((d) => d.class === 'HMD');
        if (!hmdDevice) return null;
        return poses[hmdDevice.index] || null;
      }),
      filter((hmdPose) => hmdPose !== null),
      map((hmdPose) => this.getSleepingPoseForDevicePose(hmdPose!)),
      bufferTime(1000),
      filter((buffer) => buffer.length >= 2 && uniq(buffer).length === 1),
      map((buffer) => buffer[0] as SleepingPose)
    ),
    this.forcePose$
  ).pipe(startWith('UNKNOWN' as SleepingPose), distinctUntilChanged()) as Observable<SleepingPose>;

  constructor(private openvr: OpenVRService) {}

  async init() {
    this._mode.next((await this.store.get<boolean>(SETTINGS_KEY_SLEEP_MODE)) || false);
  }

  forcePose(pose: SleepingPose) {
    this.forcePose$.next(pose);
  }

  getPoseDetectorScene(): THREE.Scene {
    return this.poseDetector.getScene();
  }

  async enableSleepMode(reason: SleepModeStatusChangeReason) {
    if (this._mode.value) return;
    reason.enabled = true;
    info(`[Sleep] Sleep mode enabled (reason=${reason.type})`);
    this._mode.next(true);
    await this.store.set(SETTINGS_KEY_SLEEP_MODE, true);
    await this.store.save();
  }

  async disableSleepMode(reason: SleepModeStatusChangeReason) {
    if (!this._mode.value) return;
    reason.enabled = false;
    info(`[Sleep] Sleep mode disabled (reason=${reason.type})`);
    this._mode.next(false);
    await this.store.set(SETTINGS_KEY_SLEEP_MODE, false);
    await this.store.save();
  }

  private getSleepingPoseForDevicePose(pose: OVRDevicePose): SleepingPose {
    if (!pose) return this.poseDetector.sleepingPose;
    this.poseDetector.processOrientation(pose.quaternion);
    return this.poseDetector.sleepingPose;
  }
}
