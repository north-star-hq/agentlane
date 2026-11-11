import type { DeviceBackend, DeviceSpec, Platform, SpecRequest } from '../devices/backend.ts';
import type { DeviceInfo, SimTools } from '../devices/tools.ts';
import { JAVA_HOME_ENV } from '../hooks/env.ts';
import type { EnvDeps } from './deps.ts';
import type { JavaHome, Toolchain } from './preflight.ts';

class Remembered<T> {
  private readonly answers = new Map<string, Promise<T>>();

  ask(key: string, question: () => Promise<T>): Promise<T> {
    const known = this.answers.get(key);
    if (known) return known;
    const answer = question();
    this.answers.set(key, answer);
    answer.catch(() => {
      if (this.answers.get(key) === answer) this.answers.delete(key);
    });
    return answer;
  }

  forget(): void {
    this.answers.clear();
  }
}

function rememberToolchain(toolchain: Toolchain): Toolchain {
  const xcode = new Remembered<string>();
  const charmaps = new Remembered<string | undefined>();
  const javas = new Remembered<JavaHome | null>();
  return {
    xcodeVersion: () => xcode.ask('', () => toolchain.xcodeVersion()),
    androidToolchain: (root, env) => toolchain.androidToolchain(root, env),
    localeCharmap: locale => charmaps.ask(locale, () => toolchain.localeCharmap(locale)),
    findJava17: env =>
      javas.ask(JSON.stringify([env[JAVA_HOME_ENV] ?? null, env.JAVA_HOME ?? null]), () => toolchain.findJava17(env)),
  };
}

function rememberBackend(backend: DeviceBackend, changed: () => void): DeviceBackend {
  const specs = new Map<string, DeviceSpec>();
  const changing =
    <A extends unknown[], R>(act: (...args: A) => R) =>
    (...args: A): R => {
      changed();
      let result: R;
      try {
        result = act(...args);
      } catch (error) {
        changed();
        throw error;
      }
      if (result instanceof Promise) return result.finally(changed) as R;
      changed();
      return result;
    };
  const resolveSpec = (request: SpecRequest): DeviceSpec => {
    const key = JSON.stringify([request.deviceType ?? null, request.runtime ?? null]);
    const known = specs.get(key);
    if (known) return { ...known };
    const spec = backend.resolveSpec(request);
    specs.set(key, spec);
    return { ...spec };
  };
  const remembered: Partial<DeviceBackend> = {
    resolveSpec,
    create: changing((name: string, spec: DeviceSpec) => backend.create(name, spec)),
    delete: changing((id: string) => {
      backend.delete(id);
    }),
    shutdown: changing((id: string) => {
      backend.shutdown(id);
    }),
    boot: changing((id: string, consolePort?: number) => backend.boot(id, consolePort)),
  };
  return new Proxy(backend, {
    get(target, property) {
      if (Object.hasOwn(remembered, property)) return remembered[property as keyof DeviceBackend];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function rememberSim(sim: SimTools, devices: Remembered<DeviceInfo | undefined>): SimTools {
  const device = async (udid: string): Promise<DeviceInfo | undefined> => {
    const info = await devices.ask(udid, () => sim.device(udid));
    return info && { ...info };
  };
  const changing = (act: (udid: string) => Promise<void>) => async (udid: string) => {
    devices.forget();
    try {
      await act(udid);
    } finally {
      devices.forget();
    }
  };
  const boot = changing(udid => sim.boot(udid));
  const shutdown = changing(udid => sim.shutdown(udid));
  return new Proxy(sim, {
    get(target, property) {
      if (property === 'device') return device;
      if (property === 'boot') return boot;
      if (property === 'shutdown') return shutdown;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface Answers {
  deps: EnvDeps;
  forgetDeviceStates: () => void;
}

export function rememberAnswers(given: EnvDeps): Answers {
  const sims = new Remembered<DeviceInfo | undefined>();
  const forgetDeviceStates = () => {
    sims.forget();
  };
  const devices: Partial<Record<Platform, DeviceBackend>> = {};
  for (const [platform, backend] of Object.entries(given.devices) as [Platform, DeviceBackend][]) {
    devices[platform] = rememberBackend(backend, forgetDeviceStates);
  }
  return {
    deps: {
      ...given,
      toolchain: rememberToolchain(given.toolchain),
      devices,
      sim: given.sim && rememberSim(given.sim, sims),
    },
    forgetDeviceStates,
  };
}
