import fs from 'node:fs';
import path from 'node:path';
import { parseInspectScreen, parseRunnerHierarchy, type ReadableScreen, type ScreenRead } from '../../src/driver/tree.ts';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const SCREENS = path.join(FIXTURES, 'ios-26.5');
const ANDROID_SCREENS = path.join(FIXTURES, 'android-36');

export type Form = 'inspect' | 'runner';

export function raw(screen: string, form: Form): string {
  return fs.readFileSync(path.join(SCREENS, `${screen}.${form}.json`), 'utf8');
}

export function read(screen: string, form: Form = 'runner'): ScreenRead {
  return form === 'runner' ? parseRunnerHierarchy(raw(screen, form)) : parseInspectScreen(raw(screen, form));
}

export function readable(screen: string, form: Form = 'runner'): ReadableScreen {
  const result = read(screen, form);
  if (!result.readable) throw new Error(`${screen}.${form} is unreadable: ${result.reason}`);
  return result;
}

export function androidReadable(screen: string): ReadableScreen {
  const result = parseInspectScreen(fs.readFileSync(path.join(ANDROID_SCREENS, `${screen}.inspect.json`), 'utf8'));
  if (!result.readable) throw new Error(`android ${screen} is unreadable: ${result.reason}`);
  return result;
}

export interface RunFailureFixture {
  name: string;
  flow: string;
  error: string;
  screen: string;
}

export function runFailures(): RunFailureFixture[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'run-failures.json'), 'utf8')) as RunFailureFixture[];
}
