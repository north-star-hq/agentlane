import { BROWSER_DRIVERS, DEFAULT_BROWSER_DRIVER } from '../browser/kinds.ts';
import { buildCacheSchema } from '../cache/config.ts';
import { CONFIG_FILE, ENV_PREFIX, envName, TOOL } from '../name.ts';

export const SERVICE_NAME_PATTERN = '^[a-z][a-z0-9-]*$';
export const BUILT_IN_SERVICE_TYPES = ['metro', 'api', 'web'] as const;
export const LAUNCH_MODES = ['dev-client', 'bundler-pin', 'hook'] as const;
export const HOOK_NAMES = ['setup', 'build', 'launch', 'signin', 'teardown'] as const;
export const PRECONDITION_STAGES = ['claim', 'build'] as const;
export const PLATFORMS = ['ios', 'android'] as const;
export const WEB_PLATFORM = 'web';
export const PROJECT_PLATFORMS = [...PLATFORMS, WEB_PLATFORM] as const;
export const EXPORT_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';
export const EXPORTS_FILE_ENV = envName('EXPORTS');
export const STORAGE_STATE_ENV = envName('STORAGE_STATE');
export const DEFAULT_WEB_PATH = '/';
export const DEFAULT_TEARDOWN_SECONDS = 120;
export const DEFAULT_VARIANT = 'Debug';
export const DEFAULT_READY_HOST = '127.0.0.1';
export const DEFAULT_READY_SECONDS = 60;
export const DEFAULT_DIAL_VALUE = 'http://localhost:{port}';

const port = { type: 'integer', minimum: 1024, maximum: 65535 } as const;
const bundleId = {
  type: 'string',
  pattern: '^[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$',
  description: 'The bundle id or package name.',
} as const;
const output = {
  type: 'string',
  minLength: 1,
  description:
    'The app the build hook produces (an .app or .apk), relative to this file. The toolkit installs it. Leave it out when the build hook installs the app itself; the installed app is then read back for the cache.',
} as const;
const device = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      minLength: 1,
      description:
        'A simulator device type, or an Android device profile such as pixel_8. Default: the newest iPhone the runtime supports, or pixel_8.',
    },
    runtime: {
      type: 'string',
      minLength: 1,
      description:
        'A simulator runtime, or an Android system image (a package id or an API level). Default: the newest installed iOS runtime, or the newest Google APIs image.',
    },
    strict: {
      type: 'boolean',
      default: false,
      description:
        'Take only a device of exactly this type and runtime. Without it, when the shared pool is full, a lane takes a free device of another type rather than deleting one to make this type.',
    },
  },
} as const;
const platformApp = (platform: string) =>
  ({
    type: 'object',
    additionalProperties: false,
    description: `What differs on ${platform}: these replace app.bundleId, app.output and app.device when \`up\` runs for ${platform}.`,
    properties: { bundleId, output, device },
  }) as const;
const host = {
  type: 'string',
  minLength: 1,
  default: DEFAULT_READY_HOST,
  description: 'The host the readiness check connects to.',
} as const;
const hook = (when: string) =>
  ({ type: 'string', minLength: 1, description: `A shell command run with \`sh -c\` ${when}.` }) as const;

export const projectSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: CONFIG_FILE,
  description: `How ${TOOL} runs this project: its mobile app, its web app, or both; the long-running services they need; what each lane gets of its own; and the hooks that set it up, build, launch and sign in. Commands run in the directory holding this file, with ${ENV_PREFIX}_* variables for the lane (device, ports, worktree), the values of the lane's resources, and LANG and LC_ALL set to a UTF-8 locale: en_US.UTF-8 on macOS, C.UTF-8 on Linux.`,
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: { type: 'string', description: 'The path or URL of this schema, for editors.' },
    app: { $ref: '#/$defs/app' },
    web: { $ref: '#/$defs/web' },
    services: {
      type: 'object',
      description: `The long-running servers the app needs, by name. Each gets a claimed port in ${ENV_PREFIX}_<NAME>_PORT (the name upper-cased, dashes as underscores).`,
      propertyNames: { pattern: SERVICE_NAME_PATTERN },
      additionalProperties: { $ref: '#/$defs/service' },
    },
    resources: {
      type: 'object',
      description: `What each lane gets of its own besides ports, such as a database, by name. \`up\` runs each create once per lane, in this order, after the setup hook and the build preconditions (also under --no-setup). The values a create exports then reach the lane's services, the hooks after setup, and \`${TOOL} exec\`, as ${ENV_PREFIX}_<NAME>_PORT does; a command never takes an exported variable from the caller's environment. When the lane ends (release, the session-end release, or a reap of a lane whose owner died or was taken over), each teardown runs, last created first.`,
      propertyNames: { pattern: SERVICE_NAME_PATTERN },
      additionalProperties: { $ref: '#/$defs/resource' },
    },
    hooks: { $ref: '#/$defs/hooks' },
    preconditions: {
      type: 'array',
      description: 'Checks `up` runs before any slow step. A failing check refuses with its fix.',
      items: { $ref: '#/$defs/precondition' },
    },
    hygiene: { $ref: '#/$defs/hygiene' },
    buildCache: buildCacheSchema,
    driver: { $ref: '#/$defs/driver' },
  },
  $defs: {
    app: {
      type: 'object',
      additionalProperties: false,
      description: 'The mobile app: what `up` builds, installs and launches on the claimed simulator or emulator.',
      required: ['platform', 'bundleId', 'launch'],
      properties: {
        platform: {
          enum: PLATFORMS,
          description: 'The platform `up` claims a device for, unless `up --platform` names another.',
        },
        bundleId,
        scheme: {
          type: 'string',
          pattern: '^[A-Za-z][A-Za-z0-9+.-]*$',
          description:
            'A URL scheme the app handles. It is approved on the simulator before it boots, so opening a link never stops at "Open in ...?".',
        },
        launch: {
          enum: LAUNCH_MODES,
          description:
            "How the app is launched. dev-client: an Expo dev client opened on the bundler with --initialUrl. bundler-pin: a React Native app whose bundler location is written to its defaults and read back, then launched. hook: the project's launch hook.",
        },
        bundler: {
          type: 'string',
          pattern: SERVICE_NAME_PATTERN,
          description: 'The service the app loads its JavaScript from. Default: the only service of type metro.',
        },
        variant: {
          type: 'string',
          minLength: 1,
          default: DEFAULT_VARIANT,
          description: `The build variant, given to hooks as ${ENV_PREFIX}_VARIANT and used by the build cache.`,
        },
        output,
        device,
        ios: platformApp('iOS'),
        android: platformApp('Android'),
      },
    },
    web: {
      type: 'object',
      additionalProperties: false,
      description: `The web app: the service that serves it and the page to open. \`up --platform web\` (the default when there is no app) claims ports and no device, starts the services, and ends on doctor with the app's URL, also given to commands as ${ENV_PREFIX}_WEB_URL.`,
      properties: {
        service: {
          type: 'string',
          pattern: SERVICE_NAME_PATTERN,
          description: 'The service that serves the web app. Default: the only service of type web.',
        },
        path: {
          type: 'string',
          pattern: '^/',
          default: DEFAULT_WEB_PATH,
          description: "The page to open, on the service's port.",
        },
        browser: { $ref: '#/$defs/browser' },
      },
    },
    browser: {
      type: 'object',
      additionalProperties: false,
      description: `The lane's own browser, which \`up\` opens on the web app. Each lane gets its own profile folder, debugging port and driver session, released with the lane. The toolkit installs the driver and its browser at pinned versions in its own data folder (\`${TOOL} browser install\`). Drive it with the driver's own CLI under \`${TOOL} exec\`, which sets the driver's session, the web app's URL and the lane's saved login. The signin hook writes that saved login, in Playwright's storage-state format, to the file named by $${STORAGE_STATE_ENV}, and the browser starts with it.`,
      properties: {
        driver: {
          enum: BROWSER_DRIVERS,
          default: DEFAULT_BROWSER_DRIVER,
          description:
            "playwright: Playwright's own CLI, playwright-cli, and Playwright tests run with `exec -- npx playwright test`. agent-browser: Vercel's agent-browser CLI, headless. Both drive the toolkit's pinned Chrome for Testing.",
        },
        headed: {
          type: 'boolean',
          default: false,
          description:
            'Show the browser window, so a person can watch it. Default: headless. Playwright only: agent-browser runs headless, on the headless shell of Chrome for Testing.',
        },
      },
    },
    resource: {
      type: 'object',
      additionalProperties: false,
      required: ['create', 'teardown'],
      properties: {
        create: {
          type: 'string',
          minLength: 1,
          description: `A shell command that makes the resource for this lane. It writes each value it exports as a NAME=value line (quotes around the value are removed) to the file named by $${EXPORTS_FILE_ENV}. Its output goes to its log, and a failing create stops \`up\` with it. It runs again at the next \`up\` when it failed or never finished, so it must cope with what a partial run left.`,
        },
        exports: {
          type: 'array',
          items: { type: 'string', pattern: EXPORT_NAME_PATTERN },
          uniqueItems: true,
          description: `The variables create writes, such as DATABASE_URL. Create must write each of them and no other. Names starting with ${ENV_PREFIX}_, and LANG and LC_ALL, are the toolkit's.`,
        },
        teardown: {
          type: 'string',
          minLength: 1,
          description: `A shell command that removes the resource when the lane ends. What it runs is recorded when create starts: this command, its folder and its variables (the lane's, plus the values create exported), so it runs even after this file changes and after the session that made the lane died. When the folder is gone (the worktree was deleted), it runs in the lane's log folder. A failed teardown is kept and tried again at the next release or reap, so it must cope with a resource that is already gone.`,
        },
        cwd: { type: 'string', minLength: 1, description: 'The directory create and teardown run in, relative to this file.' },
        teardownTimeoutSeconds: {
          type: 'number',
          exclusiveMinimum: 0,
          default: DEFAULT_TEARDOWN_SECONDS,
          description: 'How long teardown may run before it is stopped and counted as failed.',
        },
      },
    },
    service: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'start', 'ready'],
      properties: {
        type: {
          type: 'string',
          pattern: SERVICE_NAME_PATTERN,
          description: `The port block the service's port comes from: ${BUILT_IN_SERVICE_TYPES.join(', ')}, or a name of your own with \`ports\`.`,
        },
        ports: {
          type: 'array',
          prefixItems: [port, port],
          items: false,
          minItems: 2,
          description:
            "[first, last]: the port block for a type of your own. The Mac's own blocks (metro, api, web, and any in its registry config) take precedence.",
        },
        start: {
          type: 'string',
          minLength: 1,
          description: `The command that runs the server in the foreground on $${ENV_PREFIX}_<NAME>_PORT. It is started in its own process group and logged to a file per lane.`,
        },
        cwd: { type: 'string', minLength: 1, description: 'The directory to start it in, relative to this file.' },
        platforms: {
          type: 'array',
          items: { enum: PROJECT_PLATFORMS },
          minItems: 1,
          uniqueItems: true,
          description:
            'The platforms that need it, such as ["ios", "android"] for a bundler the web app does not use. `up`, `doctor` and `restart` for another platform leave it out. Leave it out to run it for every platform.',
        },
        ready: { oneOf: [{ $ref: '#/$defs/httpReady' }, { $ref: '#/$defs/tcpReady' }] },
        timeoutSeconds: {
          type: 'number',
          exclusiveMinimum: 0,
          default: DEFAULT_READY_SECONDS,
          description: 'How long to wait for the readiness check.',
        },
        dial: {
          type: 'object',
          additionalProperties: false,
          required: ['argument'],
          description: "The app dials this service: launch it with this argument, so it talks to this lane's server.",
          properties: {
            argument: { type: 'string', pattern: '^-[A-Za-z0-9_.-]+$', description: 'The launch argument, such as -apiBaseUrl.' },
            value: {
              type: 'string',
              pattern: '\\{port\\}',
              default: DEFAULT_DIAL_VALUE,
              description: "The argument's value; {port} is the service's port.",
            },
          },
        },
      },
    },
    httpReady: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path'],
      properties: {
        kind: { const: 'http' },
        path: { type: 'string', pattern: '^/', description: 'The path to GET.' },
        status: { type: 'integer', minimum: 100, maximum: 599, default: 200, description: 'The status that means ready.' },
        body: { type: 'string', minLength: 1, description: 'Text the response body must contain.' },
        host,
      },
    },
    tcpReady: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'tcp' }, host },
    },
    hooks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        setup: hook('first, to install dependencies'),
        build: hook('to build the app for the claimed device'),
        launch: hook(`to launch the app when app.launch is "hook"; ${ENV_PREFIX}_LAUNCH_ARGS holds the dial arguments`),
        signin: hook(
          `after launch, to sign in; for the web app it writes the lane's saved login, in Playwright's storage-state format, to $${STORAGE_STATE_ENV}`,
        ),
        teardown: hook(`by \`${TOOL} release\`, after the services stop and before the resources' teardowns`),
      },
    },
    precondition: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'run', 'fix'],
      properties: {
        name: { type: 'string', minLength: 1, description: 'What is checked, as a short phrase.' },
        run: { type: 'string', minLength: 1, description: 'A shell command that exits 0 when the precondition holds.' },
        fix: { type: 'string', minLength: 1, description: 'What to do when it fails.' },
        before: {
          enum: PRECONDITION_STAGES,
          default: 'claim',
          description: 'claim: checked before anything is claimed. build: checked after the setup hook, before the build.',
        },
        platforms: {
          type: 'array',
          items: { enum: PROJECT_PLATFORMS },
          minItems: 1,
          uniqueItems: true,
          description: 'The platforms it applies to. Leave it out to check it for every platform.',
        },
      },
    },
    hygiene: {
      type: 'object',
      additionalProperties: false,
      properties: {
        location: {
          type: 'object',
          additionalProperties: false,
          required: ['latitude', 'longitude'],
          properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90 },
            longitude: { type: 'number', minimum: -180, maximum: 180 },
          },
        },
        appearance: { enum: ['light', 'dark'] },
      },
    },
    driver: {
      type: 'object',
      additionalProperties: false,
      description: 'The project drives its app with the toolkit (Maestro flows); `up` and `doctor` then check for Java 17.',
      properties: {
        flows: { type: 'string', minLength: 1, description: 'The folder of committed flows, relative to this file.' },
      },
    },
  },
} as const;

export function schemaText(): string {
  return `${JSON.stringify(projectSchema, null, 2)}\n`;
}
