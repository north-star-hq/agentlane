import fs from 'node:fs';
import path from 'node:path';
import { messageOf } from '../driver/errors.ts';
import { evidenceLabel, newEvidenceFolder } from '../evidence/files.ts';
import type { BrowserControl } from './control.ts';
import { lookAtPage } from './aria.ts';

export interface KeptEvidence {
  dir: string;
  files: string[];
  problems: string[];
}

/**
 * What the lane's browser shows after a failed command: the trace of the driver's actions where the driver keeps one
 * (restarted at once, so the next failure has its own), a screenshot, the page as `look` reads it, and the console.
 */
export async function keepFailureEvidence(
  control: BrowserControl,
  evidence: string,
  label: string,
  at = new Date(),
): Promise<KeptEvidence> {
  const dir = newEvidenceFolder(evidence, `${evidenceLabel(label).slice(0, 32)}-failed`, at);
  const kept: KeptEvidence = { dir, files: [], problems: [] };
  const attempt = async (what: string, work: () => Promise<string[]>) => {
    try {
      kept.files.push(...(await work()));
    } catch (error) {
      kept.problems.push(`${what}: ${messageOf(error).split('\n')[0] ?? ''}`);
    }
  };
  if (control.tracesActions) {
    await attempt('trace', async () => {
      const files = await control.traceStop(path.join(dir, 'trace'));
      await control.traceStart();
      return files;
    });
  }
  await attempt('screenshot', async () => {
    const file = path.join(dir, 'screenshot.png');
    await control.screenshot(file);
    return fs.existsSync(file) ? [file] : [];
  });
  await attempt('page', async () => {
    const file = path.join(dir, 'page.txt');
    fs.writeFileSync(file, `${lookAtPage(await control.read()).text}\n`);
    return [file];
  });
  await attempt('console', async () => {
    const file = path.join(dir, 'console.txt');
    fs.writeFileSync(file, await control.console());
    return [file];
  });
  return kept;
}
