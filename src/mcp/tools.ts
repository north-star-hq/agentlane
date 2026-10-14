import fs from 'node:fs';
import path from 'node:path';
import { hasBrowser } from '../browser/lane-browser.ts';
import { lookAtBrowser, screenshotBrowser, type BrowserScreenTarget } from '../browser/screen.ts';
import { realBrowserTools, type BrowserTools } from '../browser/tools.ts';
import { callEngine, type EngineTarget } from '../driver/client.ts';
import { resolveCallerLane, type Caller } from '../driver/caller.ts';
import { DriverError, messageOf } from '../driver/errors.ts';
import type { EngineResponse } from '../driver/engine.ts';
import type { LookArgs, RunArgs, ScreenshotArgs } from '../driver/session.ts';
import { CLI, TOOL } from '../name.ts';
import type { ProcessTable } from '../processes.ts';
import { resolveOwner, type Owner } from '../registry/owner.ts';
import { NotClaimed, Refusal, UsageError } from '../registry/refusal.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'look',
    description:
      "What's on this session's simulator screen now, one line per element: role, id (testID), label and state. " +
      'Read it before acting and after the screen changes. A nearly empty read (maps, canvases) comes with a screenshot: tap what it shows by point. ' +
      "On a lane that holds a browser and no simulator, or with browser: true, it reads the page in the lane's browser instead: role, ref (what the browser driver's CLI acts on), name and state.",
    inputSchema: {
      type: 'object',
      properties: {
        interactiveOnly: { type: 'boolean', description: 'Only elements you can tap, toggle or type into.' },
        within: { type: 'string', description: "An id or label: show only that element's subtree." },
        depth: { type: 'integer', minimum: 1, description: 'How many levels of elements to show.' },
        bounds: { type: 'boolean', description: "Add each element's bounds in points, [x1,y1][x2,y2]. Simulator only." },
        browser: { type: 'boolean', description: "Read the lane's browser, when the lane holds a simulator as well." },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Look at the screen', readOnlyHint: true },
  },
  {
    name: 'run',
    description:
      "Run Maestro flow YAML on this session's simulator and get back what changed on screen. " +
      'A failure names the step, its kind, whether it reached the device, the screen now and selectors to try. ' +
      `Passing steps are recorded: '${CLI} record save <file>' writes them as a flow.`,
    inputSchema: {
      type: 'object',
      properties: {
        yaml: {
          type: 'string',
          description:
            'Maestro commands, with or without an `appId:` header and `---`. Without one, appId or the last app used is added.',
        },
        file: { type: 'string', description: "A flow file instead, absolute or relative to the lane's folder." },
        appId: { type: 'string', description: 'The bundle id for YAML without a header.' },
        quick: { type: 'boolean', description: 'Tap without waiting for the screen to settle; for exploring, not for proof.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Flow variables, read as ${NAME}.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Run a Maestro flow', readOnlyHint: false },
  },
  {
    name: 'screenshot',
    description:
      "This session's simulator screen as a JPEG, or the lane's browser viewport as a PNG when the lane holds a browser and no simulator, or with browser: true. " +
      '`look` finds elements more cheaply; use this to judge how the screen looks.',
    inputSchema: {
      type: 'object',
      properties: {
        scale: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Shrink the image, e.g. 0.5.' },
        browser: { type: 'boolean', description: "Screenshot the lane's browser, when the lane holds a simulator as well." },
        crop: {
          type: 'object',
          description: 'A region in points, as look prints bounds. Simulator only.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Screenshot the simulator', readOnlyHint: true },
  },
];

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  processes: ProcessTable;
  browser?: BrowserTools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(problem: string): never {
  throw new UsageError(problem, 'see the tool schema');
}

function optional<T>(
  args: Record<string, unknown>,
  key: string,
  check: (value: unknown) => value is T,
  what: string,
): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!check(value)) bad(`${key} must be ${what}`);
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function onlyKeys(tool: string, args: Record<string, unknown>): void {
  const properties = TOOLS.find(definition => definition.name === tool)?.inputSchema.properties;
  const known = typeof properties === 'object' && properties !== null ? Object.keys(properties) : [];
  const unknown = Object.keys(args).filter(key => !known.includes(key));
  if (unknown.length > 0) {
    throw new UsageError(
      `${tool} takes ${known.join(', ')}, not ${unknown.join(', ')}`,
      "drop them; the simulator and the browser always come from this session's lane",
    );
  }
}

function wantsBrowser(args: Record<string, unknown>): boolean {
  return optional(args, 'browser', isBoolean, 'true or false') === true;
}

function withoutBrowser(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'browser'));
}

export function lookArgs(args: Record<string, unknown>): LookArgs {
  onlyKeys('look', args);
  args = withoutBrowser(args);
  const out: LookArgs = {};
  const interactiveOnly = optional(args, 'interactiveOnly', isBoolean, 'true or false');
  const within = optional(args, 'within', isString, 'a string');
  const depth = optional(args, 'depth', isNumber, 'a number');
  const bounds = optional(args, 'bounds', isBoolean, 'true or false');
  if (interactiveOnly !== undefined) out.interactiveOnly = interactiveOnly;
  if (within !== undefined) out.within = within;
  if (depth !== undefined) {
    if (!Number.isInteger(depth) || depth < 1) bad('depth must be a whole number of at least 1');
    out.depth = depth;
  }
  if (bounds !== undefined) out.bounds = bounds;
  return out;
}

export function runArgs(args: Record<string, unknown>, base: string): RunArgs {
  onlyKeys('run', args);
  const out: RunArgs = {};
  const yaml = optional(args, 'yaml', isString, 'a string');
  const file = optional(args, 'file', isString, 'a string');
  if ((yaml === undefined || yaml.trim() === '') === (file === undefined || file === ''))
    bad('give exactly one of yaml and file');
  if (yaml !== undefined && yaml.trim() !== '') out.yaml = yaml;
  if (file !== undefined && file !== '') out.file = path.resolve(base, file);
  const appId = optional(args, 'appId', isString, 'a bundle id');
  if (appId !== undefined) out.appId = appId;
  const quick = optional(args, 'quick', isBoolean, 'true or false');
  if (quick !== undefined) out.quick = quick;
  const env = args.env;
  if (env !== undefined) {
    if (!isRecord(env) || !Object.values(env).every(isString)) bad('env must map variable names to strings');
    out.env = env as Record<string, string>;
  }
  return out;
}

export function screenshotArgs(args: Record<string, unknown>): ScreenshotArgs {
  onlyKeys('screenshot', args);
  args = withoutBrowser(args);
  const out: ScreenshotArgs = {};
  const scale = optional(args, 'scale', isNumber, 'a number');
  if (scale !== undefined) {
    if (scale <= 0 || scale > 1) bad('scale must be above 0 and at most 1');
    out.scale = scale;
  }
  const crop = args.crop;
  if (crop !== undefined) {
    if (!isRecord(crop) || !['x', 'y', 'width', 'height'].every(key => isNumber(crop[key])))
      bad('crop needs x, y, width and height');
    const { x, y, width, height } = crop as { x: number; y: number; width: number; height: number };
    if (width <= 0 || height <= 0) bad('crop needs a positive width and height');
    out.crop = { x, y, width, height };
  }
  return out;
}

export function contentOf(response: EngineResponse): ToolResult {
  const content: ToolContent[] = [];
  const text = response.text ?? response.error;
  if (response.image) content.push({ type: 'image', data: response.image.data, mimeType: response.image.mimeType });
  if (text !== undefined && text !== '') content.push({ type: 'text', text });
  return response.ok ? { content } : { content, isError: true };
}

async function browserLook(target: BrowserScreenTarget, args: LookArgs): Promise<ToolResult> {
  if (args.bounds === true) bad("bounds are a simulator's; the lane's browser is read by role, ref and name");
  const page = await lookAtBrowser(target, {
    ...(args.interactiveOnly === undefined ? {} : { interactiveOnly: args.interactiveOnly }),
    ...(args.within === undefined ? {} : { within: args.within }),
    ...(args.depth === undefined ? {} : { depth: args.depth }),
  });
  return { content: [{ type: 'text', text: page.text }] };
}

async function browserScreenshot(target: BrowserScreenTarget, args: ScreenshotArgs): Promise<ToolResult> {
  if (args.scale !== undefined || args.crop !== undefined)
    bad("scale and crop are a simulator's; the lane's browser screenshot is its whole viewport");
  const file = await screenshotBrowser(target);
  return {
    content: [
      { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `Saved to ${file}` },
    ],
  };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** The MCP tools' handler. It resolves the owner once, and the lane on every call, so a new lane is picked up. */
export function createToolHandler(context: ToolContext): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
  let owner: Owner | undefined;
  return async (name, args) => {
    try {
      owner ??= resolveOwner(context.env, context.processes);
      const screen = name === 'look' || name === 'screenshot';
      const asked = screen && wantsBrowser(args);
      const caller: Caller = {
        env: context.env,
        cwd: context.cwd,
        processes: context.processes,
        owner,
        need: !screen ? 'device' : asked ? 'browser' : 'either',
      };
      const { lane, stateDir } = resolveCallerLane(caller);
      if (screen && hasBrowser(lane) && (asked || lane.device === null)) {
        const browser: BrowserScreenTarget = { tools: context.browser ?? realBrowserTools, stateDir, lane, env: context.env };
        return name === 'look'
          ? await browserLook(browser, lookArgs(args))
          : await browserScreenshot(browser, screenshotArgs(args));
      }
      const target: EngineTarget = { stateDir, lane, env: context.env };
      if (name === 'look') return contentOf(await callEngine(target, { op: 'look', args: lookArgs(args) }));
      if (name === 'run') return contentOf(await callEngine(target, { op: 'run', args: runArgs(args, lane.worktree) }));
      if (name === 'screenshot') return contentOf(await callEngine(target, { op: 'screenshot', args: screenshotArgs(args) }));
      return errorResult(`Unknown tool ${JSON.stringify(name)}; this server has ${TOOLS.map(tool => tool.name).join(', ')}.`);
    } catch (error) {
      if (
        error instanceof NotClaimed ||
        error instanceof Refusal ||
        error instanceof UsageError ||
        error instanceof DriverError
      ) {
        return errorResult(`${TOOL}: ${error.message}`);
      }
      return errorResult(`${TOOL}: ${messageOf(error)}`);
    }
  };
}
