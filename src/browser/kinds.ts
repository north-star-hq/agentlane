export const BROWSER_DRIVERS = ['playwright', 'agent-browser'] as const;

export type BrowserDriverName = (typeof BROWSER_DRIVERS)[number];

export const DEFAULT_BROWSER_DRIVER: BrowserDriverName = 'playwright';

/** The ports table rows a lane's browser holds, beside its services' rows. */
export const BROWSER_DEBUG_SERVICE = 'browser';
export const BROWSER_STREAM_SERVICE = 'browser-stream';
export const BROWSER_PORT_TYPE = 'browser';
export const BROWSER_SERVICES: readonly string[] = [BROWSER_DEBUG_SERVICE, BROWSER_STREAM_SERVICE];

export function isBrowserDriver(value: unknown): value is BrowserDriverName {
  return typeof value === 'string' && (BROWSER_DRIVERS as readonly string[]).includes(value);
}
