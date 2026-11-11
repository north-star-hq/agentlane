import fs from 'node:fs';
import path from 'node:path';

export interface FakeSimulator {
  udid: string;
  name: string;
  state: string;
}

export interface FakeXcrun {
  bin: string;
  set(simulators: readonly FakeSimulator[]): void;
  deleted(): string[];
}

/**
 * An `xcrun` that answers `simctl list -j devices` with the simulators last given to `set`, in whatever state they
 * were given, and records `simctl delete <udid>` without deleting anything.
 */
export function fakeXcrun(dir: string): FakeXcrun {
  const bin = path.join(dir, 'bin');
  const listing = path.join(dir, 'devices.json');
  const calls = path.join(dir, 'calls');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'xcrun'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${calls}'`,
      'case "$1 $2" in',
      `  'simctl list') cat '${listing}' ;;`,
      "  'simctl delete') ;;",
      '  *) echo "fake xcrun: unexpected $*" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const fake: FakeXcrun = {
    bin,
    set(simulators) {
      const devices = simulators.map(({ udid, name, state }) => ({
        udid,
        name,
        state,
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
      }));
      fs.writeFileSync(listing, JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': devices } }));
    },
    deleted() {
      const lines = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n') : [];
      return lines.filter(line => line.startsWith('simctl delete ')).map(line => line.slice('simctl delete '.length));
    },
  };
  fake.set([]);
  return fake;
}
