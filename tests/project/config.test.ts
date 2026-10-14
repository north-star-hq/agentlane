import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  declaredPlatforms,
  findProjectConfig,
  forPlatform,
  loadProjectConfig,
  parseProjectConfig,
  ProjectConfigError,
} from '../../src/project/config.ts';
import { UsageError } from '../../src/registry/refusal.ts';
import { projectSchema, schemaText } from '../../src/project/schema.ts';
import { SchemaValidator } from '../../src/project/validate.ts';
import { tempDir } from '../support/fakes.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXAMPLE = path.join(ROOT, 'examples', 'expo-app', 'agentlane.json');

interface Service {
  type: string;
  start: string;
  ready: Record<string, unknown>;
  dial?: Record<string, unknown>;
  ports?: number[];
  timeoutSeconds?: number;
}

const APP = { platform: 'ios', bundleId: 'com.example.app', launch: 'dev-client' };
const METRO: Service = { type: 'metro', start: 'serve', ready: { kind: 'http', path: '/status' } };
const API: Service = { type: 'api', start: 'api', ready: { kind: 'tcp' }, dial: { argument: '-apiBaseUrl' } };
const WEB: Service = { type: 'web', start: 'next dev', ready: { kind: 'http', path: '/' } };
const DB = { create: 'make-db', exports: ['DATABASE_URL'], teardown: 'drop-db' };

function config(
  over: { app?: Record<string, unknown>; services?: Record<string, Service>; extra?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return { app: { ...APP, ...over.app }, services: over.services ?? { metro: METRO, api: API }, ...over.extra };
}

function problemsOf(raw: unknown): { path: string; schemaPath: string; message: string }[] {
  try {
    parseProjectConfig(raw, '/project/agentlane.json');
  } catch (error) {
    assert.ok(error instanceof ProjectConfigError, String(error));
    return [...error.problems];
  }
  assert.fail('the config was accepted');
}

test("the example app's config is valid and normalizes to the example's real commands", () => {
  const config = loadProjectConfig(EXAMPLE);
  assert.equal(config.dir, path.dirname(EXAMPLE));
  assert.deepEqual(config.app, {
    platform: 'ios',
    bundleId: 'com.example.expoapp',
    scheme: 'expoexample',
    launch: 'dev-client',
    bundler: 'metro',
    variant: 'Debug',
    output: null,
    device: {},
  });
  const [metro, api] = config.services;
  assert.deepEqual(metro?.ready, {
    kind: 'http',
    host: '127.0.0.1',
    path: '/status',
    status: 200,
    body: 'packager-status:running',
  });
  assert.equal(metro.timeoutMs, 120_000);
  assert.deepEqual(api?.dial, { argument: '-apiBaseUrl', value: 'http://localhost:{port}' });
  assert.equal(api.cwd, config.dir);
  assert.deepEqual(
    config.preconditions.map(p => [p.name, p.before]),
    [
      ['CocoaPods is installed', 'claim'],
      ['node_modules is installed', 'build'],
    ],
  );
  assert.deepEqual(config.buildCache?.inputs[3], { kind: 'command', run: 'pod --version', platforms: ['ios'] });
  assert.deepEqual(config.driver, { flows: '.maestro' });
});

test('the committed schema file is the one the code validates with', () => {
  const committed = fs.readFileSync(path.join(ROOT, 'schema', 'agentlane.schema.json'), 'utf8');
  assert.equal(committed, schemaText(), 'schema/agentlane.schema.json is stale: run pnpm run schema');
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')) as { $schema: string };
  assert.equal(path.resolve(path.dirname(EXAMPLE), example.$schema), path.join(ROOT, 'schema', 'agentlane.schema.json'));
});

test('an invalid config is refused with the path of the bad field and the schema rule it broke', () => {
  const cases: [string, unknown, string, string, RegExp][] = [
    [
      'no app and no web app',
      {},
      '',
      '(cross-field rule)',
      /declares no app: add app \(a mobile app\), web \(a web app\), or both/,
    ],
    [
      'a web app with two web services and none named',
      { web: {}, services: { site: WEB, admin: WEB } },
      '/web/service',
      '(cross-field rule)',
      /2 services have type web/,
    ],
    [
      'a web app naming no service',
      { web: { service: 'site' }, services: { web: WEB } },
      '/web/service',
      '(cross-field rule)',
      /names no service; the services are: web/,
    ],
    [
      'a web path without a slash',
      { web: { path: 'admin' }, services: { web: WEB } },
      '/web/path',
      '#/$defs/web/properties/path/pattern',
      /must match/,
    ],
    [
      'a resource without a teardown',
      config({ extra: { resources: { db: { create: 'make-db' } } } }),
      '/resources/db/teardown',
      '#/$defs/resource/required',
      /is required/,
    ],
    [
      'a resource exporting a toolkit variable',
      config({ extra: { resources: { db: { ...DB, exports: ['AGENTLANE_API_PORT'] } } } }),
      '/resources/db/exports/0',
      '(cross-field rule)',
      /AGENTLANE_API_PORT is set by agentlane itself/,
    ],
    [
      'two resources exporting one variable',
      config({ extra: { resources: { db: DB, replica: { ...DB, exports: ['DATABASE_URL'] } } } }),
      '/resources/replica/exports/0',
      '(cross-field rule)',
      /DATABASE_URL is exported by resource db too/,
    ],
    [
      'an export name that is not a variable name',
      config({ extra: { resources: { db: { ...DB, exports: ['database-url'] } } } }),
      '/resources/db/exports/0',
      '#/$defs/resource/properties/exports/items/pattern',
      /must match/,
    ],
    [
      'a launch hook without a mobile app',
      { web: {}, services: { web: WEB }, hooks: { launch: 'open' } },
      '/hooks/launch',
      '(cross-field rule)',
      /launches the mobile app, and there is no app/,
    ],
    [
      'unknown launch mode',
      config({ app: { launch: 'deeplink' } }),
      '/app/launch',
      '#/$defs/app/properties/launch/enum',
      /must be one of "dev-client", "bundler-pin", "hook"/,
    ],
    [
      'status as text',
      config({ services: { metro: { ...METRO, ready: { kind: 'http', path: '/status', status: '200' } }, api: API } }),
      '/services/metro/ready/status',
      '#/$defs/httpReady/properties/status/type',
      /must be an integer/,
    ],
    ['a misspelled top-level field', config({ extra: { hook: {} } }), '/hook', '#/additionalProperties', /is not a known field/],
    [
      'an upper-case service name',
      config({ services: { metro: METRO, API } }),
      '/services/API',
      '#/properties/services/propertyNames/pattern',
      /must match/,
    ],
    [
      'an unknown ready kind',
      config({ services: { metro: METRO, api: { ...API, ready: { kind: 'udp' } } } }),
      '/services/api/ready',
      '#/$defs/service/properties/ready/oneOf',
      /allowed shapes/,
    ],
    [
      'a dial argument without a dash',
      config({ services: { metro: METRO, api: { ...API, dial: { argument: 'apiBaseUrl' } } } }),
      '/services/api/dial/argument',
      '#/$defs/service/properties/dial/properties/argument/pattern',
      /must match/,
    ],
    [
      'a dial value without {port}',
      config({ services: { metro: METRO, api: { ...API, dial: { argument: '-apiBaseUrl', value: 'http://localhost:8080' } } } }),
      '/services/api/dial/value',
      '#/$defs/service/properties/dial/properties/value/pattern',
      /must match/,
    ],
    [
      'an unknown cache platform',
      config({ extra: { buildCache: { inputs: [{ kind: 'command', run: 'x', platforms: ['web'] }], cacheableVariants: [] } } }),
      '/buildCache/inputs/0/platforms/0',
      '#/properties/buildCache/properties/inputs/items/oneOf/1/properties/platforms/items/enum',
      /must be one of "ios", "android", not "web"/,
    ],
    [
      'an unknown cache input kind',
      config({ extra: { buildCache: { inputs: [{ kind: 'glob', paths: ['x'] }], cacheableVariants: [] } } }),
      '/buildCache/inputs/0',
      '#/properties/buildCache/properties/inputs/items/oneOf',
      /must match one of the 2 allowed shapes/,
    ],
    [
      'ports for a built-in type',
      config({ services: { metro: METRO, api: { ...API, ports: [41500, 41519] } } }),
      '/services/api/ports',
      '(cross-field rule)',
      /not allowed for type api/,
    ],
    [
      'a custom type without ports',
      config({ services: { metro: METRO, api: API, admin: { type: 'admin', start: 'x', ready: { kind: 'tcp' } } } }),
      '/services/admin/ports',
      '(cross-field rule)',
      /required for type admin/,
    ],
    [
      'a launch hook without launch "hook"',
      config({ extra: { hooks: { launch: 'open' } } }),
      '/hooks/launch',
      '(cross-field rule)',
      /not used when app.launch is "dev-client"/,
    ],
    [
      'launch "hook" without a launch hook',
      config({ app: { launch: 'hook' } }),
      '/hooks/launch',
      '(cross-field rule)',
      /is required/,
    ],
    [
      'a dev-client launch with no bundler service',
      config({ services: { api: API } }),
      '/app/bundler',
      '(cross-field rule)',
      /0 services have type metro/,
    ],
    [
      'a bundler that names no service',
      config({ app: { bundler: 'packager' } }),
      '/app/bundler',
      '(cross-field rule)',
      /names no service/,
    ],
  ];
  for (const [name, raw, where, rule, message] of cases) {
    const problems = problemsOf(raw);
    const found = problems.find(p => p.path === where);
    assert.ok(found, `${name}: no problem at ${where}; got ${JSON.stringify(problems)}`);
    assert.equal(found.schemaPath, rule, `${name}: schema path`);
    assert.match(found.message, message, name);
  }
});

test('the refusal message names the file, the field and the schema rule', () => {
  assert.throws(
    () =>
      parseProjectConfig(config({ services: { metro: { ...METRO, timeoutSeconds: 0 }, api: API } }), '/project/agentlane.json'),
    (error: unknown) =>
      error instanceof ProjectConfigError &&
      error.message.startsWith('/project/agentlane.json is not a valid agentlane.json:\n') &&
      error.message.includes('/services/metro/timeoutSeconds must be more than 0') &&
      error.message.includes('(schema: #/$defs/service/properties/timeoutSeconds/exclusiveMinimum)'),
  );
});

test('a file that is not JSON is refused with the parser position', t => {
  const dir = tempDir('config-syntax');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'agentlane.json');
  fs.writeFileSync(file, '{ "app": { "platform": "ios", }\n');
  assert.throws(
    () => loadProjectConfig(file),
    (error: unknown) =>
      error instanceof ProjectConfigError &&
      error.problems[0]?.schemaPath === '(JSON syntax)' &&
      /position|line/.test(error.message),
  );
});

test('the config is found in this folder or above it, up to the top of the repository and no further', t => {
  const outer = tempDir('config-find');
  t.after(() => {
    fs.rmSync(outer, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outer, 'agentlane.json'), '{}');
  const repo = path.join(outer, 'repo');
  const deep = path.join(repo, 'apps', 'mobile', 'src');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  assert.equal(findProjectConfig(deep), null, 'a config outside the repository was used');
  fs.writeFileSync(path.join(repo, 'apps', 'mobile', 'agentlane.json'), '{}');
  assert.equal(findProjectConfig(deep), path.join(fs.realpathSync(repo), 'apps', 'mobile', 'agentlane.json'));
});

test('the validator refuses a schema keyword it does not implement, so the schema cannot outgrow it', () => {
  assert.deepEqual(new SchemaValidator(projectSchema).validate(config()), []);
  assert.throws(
    () => new SchemaValidator({ type: 'object', patternProperties: {} }).validate({}),
    /'patternProperties' .* is not supported/,
  );
});

test('forPlatform gives the app as up sees it on a platform: app.android or app.ios replace the fields they name', () => {
  const parsed = parseProjectConfig(
    config({
      app: {
        output: 'build/App.app',
        device: { type: 'iPhone 17' },
        android: { output: 'build/app.apk', device: { type: 'pixel_9', runtime: '36' } },
        ios: { bundleId: 'com.example.app.ios' },
      },
    }),
    '/project/agentlane.json',
  );
  assert.equal(parsed.app?.platform, 'ios');
  assert.equal(parsed.app.bundleId, 'com.example.app.ios');
  assert.equal(parsed.app.output, 'build/App.app');
  const android = forPlatform(parsed, 'android');
  assert.deepEqual(
    {
      platform: android.app?.platform,
      bundleId: android.app?.bundleId,
      output: android.app?.output,
      device: android.app?.device,
    },
    { platform: 'android', bundleId: 'com.example.app', output: 'build/app.apk', device: { type: 'pixel_9', runtime: '36' } },
  );
  assert.equal(forPlatform(android, 'ios').app?.bundleId, 'com.example.app.ios');
  assert.deepEqual(forPlatform(android, 'ios').app?.device, { type: 'iPhone 17' });

  const example = forPlatform(loadProjectConfig(EXAMPLE), 'android');
  assert.equal(example.app?.output, 'build/android/app-debug.apk');
  assert.deepEqual(
    example.preconditions.map(p => [p.name, p.platforms]),
    [
      ['CocoaPods is installed', ['ios']],
      ['node_modules is installed', null],
    ],
  );
});

test('app.android accepts only what differs per platform, and a precondition names real platforms', () => {
  assert.match(
    problemsOf(config({ app: { android: { launch: 'hook' } } }))
      .map(p => `${p.path} ${p.message}`)
      .join('\n'),
    /\/app\/android/,
  );
  assert.ok(
    problemsOf(config({ extra: { preconditions: [{ name: 'x', run: 'true', fix: 'y', platforms: ['windows'] }] } })).some(p =>
      p.path.startsWith('/preconditions/0/platforms'),
    ),
  );
});

test('a web-only config validates: no app, a web app served by its only web service, and the page to open', () => {
  const raw = {
    web: { path: '/admin' },
    services: { site: { ...WEB, cwd: 'apps/web' }, api: { type: 'api', start: 'api', ready: { kind: 'tcp' } } },
    hooks: { setup: 'pnpm install' },
    preconditions: [{ name: 'only for web', run: 'true', fix: 'none', platforms: ['web'] }],
  };
  assert.deepEqual(new SchemaValidator(projectSchema).validate(raw), []);
  const parsed = parseProjectConfig(raw, '/project/agentlane.json');
  assert.equal(parsed.platform, 'web');
  assert.equal(parsed.app, null);
  assert.deepEqual(parsed.web, { service: 'site', path: '/admin', browser: { driver: 'playwright', headed: false } });
  assert.deepEqual(declaredPlatforms(parsed), ['web']);
  assert.equal(forPlatform(parsed, 'web').platform, 'web');
  assert.throws(
    () => forPlatform(parsed, 'ios'),
    (error: unknown) => error instanceof UsageError && /declares no mobile app[\s\S]*up --platform web/.test(error.message),
  );
  assert.deepEqual(parseProjectConfig({ web: { service: 'api' }, services: raw.services }, '/p/agentlane.json').web, {
    service: 'api',
    path: '/',
    browser: { driver: 'playwright', headed: false },
  });
});

test('a config with both apps defaults to the mobile one, and forPlatform gives either', () => {
  const parsed = parseProjectConfig(
    config({ services: { metro: METRO, api: API, web: WEB }, extra: { web: {} } }),
    '/project/agentlane.json',
  );
  assert.equal(parsed.platform, 'ios');
  assert.deepEqual(declaredPlatforms(parsed), ['ios', 'android', 'web']);
  const web = forPlatform(parsed, 'web');
  assert.equal(web.platform, 'web');
  assert.equal(web.app, null);
  assert.equal(forPlatform(web, 'android').app?.platform, 'android');
  assert.throws(
    () => forPlatform(parseProjectConfig(config(), '/project/agentlane.json'), 'web'),
    (error: unknown) => error instanceof UsageError && error.message.includes('declares no web app'),
  );
});

test("the web app picks its browser driver, and a service's platforms limit the platforms it runs for", () => {
  const raw = config({
    services: {
      metro: { ...METRO, platforms: ['ios', 'android'] } as Service,
      api: API,
      web: { ...WEB, platforms: ['web'] } as Service,
    },
    extra: { web: { browser: { driver: 'agent-browser' } } },
  });
  assert.deepEqual(new SchemaValidator(projectSchema).validate(raw), []);
  const parsed = parseProjectConfig(raw, '/project/agentlane.json');
  assert.deepEqual(parsed.web?.browser, { driver: 'agent-browser', headed: false });
  const headed = config({ extra: { web: { browser: { headed: true } } }, services: { metro: METRO, web: WEB } });
  assert.deepEqual(parseProjectConfig(headed, '/project/agentlane.json').web?.browser, { driver: 'playwright', headed: true });
  assert.deepEqual(
    parsed.services.map(s => s.name),
    ['metro', 'api'],
  );
  assert.deepEqual(
    parsed.allServices.map(s => s.name),
    ['metro', 'api', 'web'],
  );
  assert.deepEqual(
    forPlatform(parsed, 'web').services.map(s => s.name),
    ['api', 'web'],
  );
  assert.deepEqual(
    forPlatform(parsed, 'android').services.map(s => s.name),
    ['metro', 'api'],
  );
  assert.deepEqual(parsed.services[0]?.platforms, ['ios', 'android']);
  assert.equal(parsed.services[1]?.platforms, null);

  assert.ok(
    problemsOf(config({ extra: { web: { browser: { driver: 'selenium' } } }, services: { metro: METRO, web: WEB } })).some(
      p => p.path === '/web/browser/driver',
    ),
  );
  assert.ok(
    problemsOf(
      config({ extra: { web: { browser: { driver: 'agent-browser', headed: true } } }, services: { metro: METRO, web: WEB } }),
    ).some(p => p.path === '/web/browser/headed' && p.message.includes('use driver playwright to watch the browser')),
  );
  assert.ok(
    problemsOf(config({ services: { metro: { ...METRO, platforms: ['android'] } as Service } })).some(
      p =>
        p.path === '/services/metro/platforms' &&
        p.message.includes('leaves out ios, and the app loads its JavaScript from metro there'),
    ),
  );
  assert.ok(
    problemsOf(config({ services: { metro: METRO, web: { ...WEB, platforms: ['ios'] } as Service }, extra: { web: {} } })).some(
      p => p.path === '/services/web/platforms' && p.message.includes('serves the web app'),
    ),
  );
  assert.ok(problemsOf(config({ services: { metro: METRO, browser: WEB } })).some(p => p.path === '/services/browser'));
  const iosOnly = parseProjectConfig(
    config({ services: { metro: { ...METRO, platforms: ['ios'] } as Service } }),
    '/project/agentlane.json',
  );
  assert.throws(
    () => forPlatform(iosOnly, 'android'),
    (error: unknown) => error instanceof UsageError && /metro's platforms in .* leave out android/.test(error.message),
  );
});

test('resources normalize in the order declared, with their folder, exports and teardown timeout', () => {
  const parsed = parseProjectConfig(
    config({
      extra: {
        resources: {
          pg: { create: 'start-pg', exports: ['PGPORT'], teardown: 'stop-pg', teardownTimeoutSeconds: 30 },
          db: { ...DB, cwd: 'apps/api' },
          cache: { create: 'mkdir cache', teardown: 'rm -rf cache' },
        },
      },
    }),
    '/project/agentlane.json',
  );
  assert.deepEqual(parsed.resources, [
    { name: 'pg', create: 'start-pg', exports: ['PGPORT'], teardown: 'stop-pg', cwd: '/project', teardownTimeoutMs: 30_000 },
    {
      name: 'db',
      create: 'make-db',
      exports: ['DATABASE_URL'],
      teardown: 'drop-db',
      cwd: '/project/apps/api',
      teardownTimeoutMs: 120_000,
    },
    { name: 'cache', create: 'mkdir cache', exports: [], teardown: 'rm -rf cache', cwd: '/project', teardownTimeoutMs: 120_000 },
  ]);
});
