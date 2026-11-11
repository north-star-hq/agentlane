export type Platform = 'ios' | 'android';

export const DEVICE_NOUN: Readonly<Record<Platform, string>> = { ios: 'an iOS simulator', android: 'an Android emulator' };

export interface SpecRequest {
  deviceType?: string | undefined;
  runtime?: string | undefined;
}

export interface DeviceSpec {
  deviceType: string;
  deviceTypeName: string;
  runtime: string;
  runtimeName: string;
}

export interface BackendDevice {
  id: string;
  name: string;
  deviceType: string;
  runtime: string;
  booted: boolean;
  stopped?: boolean;
  serial?: string;
  disk?: DeviceDisk;
}

export interface DeviceDisk {
  paths: string[];
  bytes: number | null;
}

export type WhenRunning = 'shut-down' | 'refuse';

export interface DeviceBackend {
  readonly platform: Platform;
  resolveSpec(request: SpecRequest): DeviceSpec;
  list(): BackendDevice[];
  create(name: string, spec: DeviceSpec): string;
  delete(id: string, whenRunning?: WhenRunning): void;
  shutdown(id: string): void;
  boot(id: string, consolePort?: number): Promise<void>;
}

export class DeviceBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceBackendError';
  }
}

export class DeviceRunningError extends DeviceBackendError {
  constructor(id: string) {
    super(`${id} is running, so it is not deleted`);
    this.name = 'DeviceRunningError';
  }
}
