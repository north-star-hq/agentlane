import { PROJECT_PLATFORMS } from '../project/schema.ts';

/** How long a call waits on another call parking or waking its lane. */
export const LANE_WAIT_MS = 30 * 60_000;

/** How long waking a lane waits for a pool device, as `up` does by default, once for each platform it wakes. */
export const WAKE_WAIT_MS = 600_000;

/** The longest entering a lane waits on its bounded steps: another call's park or wake, then each platform's wait for a device. */
export const LONGEST_ENTRY_MS = LANE_WAIT_MS + PROJECT_PLATFORMS.length * WAKE_WAIT_MS;
