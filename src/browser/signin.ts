import fs from 'node:fs';
import { STORAGE_STATE_ENV } from '../project/schema.ts';

/** A cookie as Playwright's storage-state format writes it. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StoredOrigin {
  origin: string;
  localStorage: { name: string; value: string }[];
}

/** Playwright's storage-state format: the lane's saved login, as the signin hook writes it. */
export interface StorageState {
  cookies: StoredCookie[];
  origins: StoredOrigin[];
}

/** What can be said about a saved login without its values: never a cookie's value or a stored item's. */
export interface SavedLogin {
  file: string;
  cookies: number;
  domains: string[];
  origins: string[];
}

export class SignInFailed extends Error {
  readonly problems: readonly string[];

  constructor(file: string, problems: readonly string[], fix: string) {
    const shown = problems.slice(0, 8).map(p => `  ${p}`);
    const more = problems.length > shown.length ? [`  ... and ${String(problems.length - shown.length)} more`] : [];
    super(
      `the signin hook's saved login at ${file} is not Playwright's storage-state format:\n${[...shown, ...more].join('\n')}\nto fix: ${fix}`,
    );
    this.name = 'SignInFailed';
    this.problems = problems;
  }
}

const SAME_SITE = ['Strict', 'Lax', 'None'] as const;
const WRITE_IT = `write the login there as Playwright's storage state: playwright-cli state-save "$${STORAGE_STATE_ENV}" after signing in under agentlane exec, or context.storageState({ path: process.env.${STORAGE_STATE_ENV} }) in a script, or {"cookies": [...], "origins": [...]} built from the app's own login API`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'string' ? 'text' : `a ${typeof value}`;
}

function cookieProblems(raw: unknown, i: number): string[] {
  const at = `cookies[${String(i)}]`;
  if (!isRecord(raw)) return [`${at} is ${kind(raw)}, not an object`];
  const problems: string[] = [];
  for (const key of ['name', 'value', 'domain', 'path'] as const) {
    if (typeof raw[key] !== 'string')
      problems.push(`${at}.${key} is ${raw[key] === undefined ? 'missing' : kind(raw[key])}; it must be text`);
  }
  if (typeof raw.name === 'string' && raw.name === '') problems.push(`${at}.name is empty`);
  if (typeof raw.expires !== 'number')
    problems.push(
      `${at}.expires is ${raw.expires === undefined ? 'missing' : kind(raw.expires)}; it must be a Unix time in seconds, or -1 for a session cookie`,
    );
  for (const key of ['httpOnly', 'secure'] as const) {
    if (typeof raw[key] !== 'boolean')
      problems.push(`${at}.${key} is ${raw[key] === undefined ? 'missing' : kind(raw[key])}; it must be true or false`);
  }
  if (!SAME_SITE.includes(raw.sameSite as (typeof SAME_SITE)[number])) {
    const got =
      typeof raw.sameSite === 'string' ? `"${raw.sameSite}"` : raw.sameSite === undefined ? 'missing' : kind(raw.sameSite);
    problems.push(`${at}.sameSite is ${got}; Playwright takes "Strict", "Lax" or "None"`);
  }
  return problems;
}

function originProblems(raw: unknown, i: number): string[] {
  const at = `origins[${String(i)}]`;
  if (!isRecord(raw)) return [`${at} is ${kind(raw)}, not an object`];
  const problems: string[] = [];
  if (typeof raw.origin !== 'string')
    problems.push(
      `${at}.origin is ${raw.origin === undefined ? 'missing' : kind(raw.origin)}; it must be an origin such as http://localhost:41300`,
    );
  else {
    try {
      if (new URL(raw.origin).origin !== raw.origin)
        problems.push(`${at}.origin "${raw.origin}" is not an origin: no path, no trailing slash`);
    } catch {
      problems.push(`${at}.origin "${raw.origin}" is not a URL`);
    }
  }
  if (!Array.isArray(raw.localStorage))
    problems.push(
      `${at}.localStorage is ${raw.localStorage === undefined ? 'missing' : kind(raw.localStorage)}; it must be a list of {"name", "value"}`,
    );
  else {
    raw.localStorage.forEach((item: unknown, j) => {
      if (!isRecord(item) || typeof item.name !== 'string' || typeof item.value !== 'string')
        problems.push(`${at}.localStorage[${String(j)}] must be {"name": text, "value": text}`);
    });
  }
  return problems;
}

function cookieApplies(domain: string, host: string): boolean {
  const bare = domain.startsWith('.') ? domain.slice(1) : domain;
  return host === bare || host.endsWith(`.${bare}`);
}

/** The problems with a parsed storage state; none means it is a storage state the browser can start with. */
export function storageStateProblems(raw: unknown, url: string | null): string[] {
  if (!isRecord(raw)) return [`the file holds ${kind(raw)}, not an object with "cookies" and "origins"`];
  const problems: string[] = [];
  if (!Array.isArray(raw.cookies))
    problems.push(
      `"cookies" is ${raw.cookies === undefined ? 'missing' : kind(raw.cookies)}; it must be a list (empty when the app keeps its login in localStorage)`,
    );
  else raw.cookies.forEach((c: unknown, i) => problems.push(...cookieProblems(c, i)));
  if (!Array.isArray(raw.origins))
    problems.push(
      `"origins" is ${raw.origins === undefined ? 'missing' : kind(raw.origins)}; it must be a list (empty when the app keeps its login in cookies)`,
    );
  else raw.origins.forEach((o: unknown, i) => problems.push(...originProblems(o, i)));
  if (problems.length > 0 || url === null) return problems;
  const state = raw as unknown as StorageState;
  const app = new URL(url);
  if (state.cookies.length === 0 && state.origins.length === 0)
    return ['it holds no cookie and no origin, so the browser would open the web app signed out'];
  const applies =
    state.cookies.some(c => cookieApplies(c.domain, app.hostname)) || state.origins.some(o => o.origin === app.origin);
  if (!applies) {
    const domains = [...new Set(state.cookies.map(c => c.domain))];
    const origins = state.origins.map(o => o.origin);
    return [
      `none of it applies to ${app.origin}, where the browser opens the web app: its cookies are for ${domains.join(', ') || 'no domain'}${origins.length > 0 ? ` and its origins are ${origins.join(', ')}` : ''}; write cookies for ${app.hostname}, or the origin ${app.origin}`,
    ];
  }
  return problems;
}

function jsonPosition(error: unknown): string {
  const position = /position (\d+)/.exec(error instanceof Error ? error.message : '')?.[1];
  return position === undefined ? '' : ` (at character ${position})`;
}

/**
 * Checks the saved login the signin hook wrote, makes it readable by its owner alone, and describes it without a single
 * value from it. The file's text never reaches an error or a log: a JSON error names only its position.
 */
export function acceptSavedLogin(file: string, url: string | null): SavedLogin {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new SignInFailed(
      file,
      [
        missing
          ? `the signin hook exited 0 without writing it ($${STORAGE_STATE_ENV})`
          : `it can't be read: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`,
      ],
      WRITE_IT,
    );
  }
  fs.chmodSync(file, 0o600);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SignInFailed(file, [`it is not JSON${jsonPosition(error)}`], WRITE_IT);
  }
  const problems = storageStateProblems(raw, url);
  if (problems.length > 0) throw new SignInFailed(file, problems, WRITE_IT);
  const state = raw as StorageState;
  return {
    file,
    cookies: state.cookies.length,
    domains: [...new Set(state.cookies.map(c => c.domain))],
    origins: state.origins.map(o => o.origin),
  };
}

export function describeSavedLogin(login: SavedLogin): string {
  const parts = [
    `${String(login.cookies)} cookie${login.cookies === 1 ? '' : 's'}${login.domains.length > 0 ? ` for ${login.domains.join(', ')}` : ''}`,
  ];
  if (login.origins.length > 0) parts.push(`local storage for ${login.origins.join(', ')}`);
  return parts.join(' and ');
}
