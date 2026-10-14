import { envName } from '../name.ts';

export const INPUT_PLATFORMS = ['ios', 'android'] as const;

export type InputPlatform = (typeof INPUT_PLATFORMS)[number];

export interface FilesInput {
  kind: 'files';
  paths: string[];
  exclude?: string[];
  platforms?: InputPlatform[];
}

export interface CommandInput {
  kind: 'command';
  run: string;
  platforms?: InputPlatform[];
}

export type CacheInput = FilesInput | CommandInput;

export interface BuildCacheConfig {
  inputs: CacheInput[];
  cacheableVariants: string[];
  envFile?: string;
  maxAgeDays?: number;
  maxEntries?: number;
}

export function inputsFor(inputs: readonly CacheInput[], platform: string): CacheInput[] {
  return inputs.filter(input => input.platforms === undefined || (input.platforms as readonly string[]).includes(platform));
}

const platformsSchema = {
  type: 'array',
  minItems: 1,
  uniqueItems: true,
  items: { enum: INPUT_PLATFORMS },
  description: 'The platforms whose key includes this input. Leave it out to include it for every platform.',
} as const;

export const DEFAULT_MAX_AGE_DAYS = 14;
export const DEFAULT_MAX_ENTRIES = 6;

export const buildCacheSchema = {
  $id: 'buildCache',
  type: 'object',
  description: `Lets the toolkit skip the native build when its inputs have not changed. The key also covers the platform, the build variant, the toolchain and the contents of the env file the build uses. The toolchain is the Xcode version for iOS. For Android it is the version of the JDK at ${envName('JAVA_HOME')} or JAVA_HOME (else the JDK 17 the toolkit finds), which the build hook gets as JAVA_HOME, the Gradle distribution in android/gradle/wrapper/gradle-wrapper.properties when that file is not git-ignored (a generated wrapper follows the inputs that generate it, such as the lockfile), and the revision of every installed Android SDK build-tools, platform, NDK and CMake package.`,
  additionalProperties: false,
  required: ['inputs', 'cacheableVariants'],
  properties: {
    inputs: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'paths'],
            properties: {
              kind: { const: 'files' },
              paths: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1 },
                description:
                  'Files, directories or globs (`*`, `**`), relative to the directory holding the config file. Matched as git glob pathspecs over tracked files and untracked files git does not ignore; each enters the key by path, mode and content.',
              },
              exclude: {
                type: 'array',
                items: { type: 'string', minLength: 1 },
                description: 'Files, directories or globs to leave out of `paths`.',
              },
              platforms: platformsSchema,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'run'],
            properties: {
              kind: { const: 'command' },
              run: {
                type: 'string',
                minLength: 1,
                description:
                  "A shell command run with `sh -c` in the config file's directory, with the lane's environment. Its stdout enters the key; a non-zero exit means no key, so the build runs uncached.",
              },
              platforms: platformsSchema,
            },
          },
        ],
      },
    },
    cacheableVariants: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      description:
        'The build variants whose output may be stored and served. Leave out any variant that embeds its JS bundle, such as a Release build.',
    },
    envFile: {
      type: 'string',
      minLength: 1,
      description:
        "An env file the build bakes in, relative to the config file's directory. Its contents enter the key; a missing file counts as absent. Use this for files git ignores, which a files input never sees.",
    },
    maxAgeDays: {
      type: 'number',
      exclusiveMinimum: 0,
      default: DEFAULT_MAX_AGE_DAYS,
      description: 'An entry unused for longer than this is pruned.',
    },
    maxEntries: {
      type: 'integer',
      minimum: 1,
      default: DEFAULT_MAX_ENTRIES,
      description: 'Only the most recently used entries up to this count are kept.',
    },
  },
} as const;

export const exampleBuildCacheConfig: BuildCacheConfig = {
  inputs: [
    {
      kind: 'files',
      paths: [
        'apps/mobile/ios',
        'apps/mobile/modules',
        'apps/mobile/package.json',
        'apps/mobile/react-native.config.js',
        'pnpm-lock.yaml',
      ],
      exclude: ['apps/mobile/ios/Podfile.lock'],
    },
    {
      kind: 'command',
      run: "grep -Ev '^  (hermes-engine|React-Core-prebuilt|ReactNativeDependencies): [0-9a-f]+$' apps/mobile/ios/Podfile.lock",
    },
  ],
  cacheableVariants: ['Debug'],
};

export class BuildCacheConfigError extends Error {
  override name = 'BuildCacheConfigError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, where: string, minItems: number): string[] {
  if (!Array.isArray(value) || value.length < minItems || !value.every(v => typeof v === 'string' && v.length > 0)) {
    throw new BuildCacheConfigError(
      `${where} must be a list of non-empty strings${minItems > 0 ? ` with at least ${String(minItems)} item` : ''}`,
    );
  }
  return value as string[];
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length > 0) throw new BuildCacheConfigError(`${where} has unknown field(s): ${extra.join(', ')}`);
}

function parsePlatforms(value: unknown, where: string): InputPlatform[] {
  const list = stringList(value, where, 1);
  const unknown = list.filter(p => !(INPUT_PLATFORMS as readonly string[]).includes(p));
  if (unknown.length > 0) throw new BuildCacheConfigError(`${where} has unknown platform(s): ${unknown.join(', ')}`);
  if (new Set(list).size !== list.length) throw new BuildCacheConfigError(`${where} lists a platform twice`);
  return list as InputPlatform[];
}

function parseInput(value: unknown, where: string): CacheInput {
  if (!isRecord(value)) throw new BuildCacheConfigError(`${where} must be an object`);
  let input: CacheInput;
  if (value.kind === 'files') {
    onlyKeys(value, ['kind', 'paths', 'exclude', 'platforms'], where);
    input = { kind: 'files', paths: stringList(value.paths, `${where}.paths`, 1) };
    if (value.exclude !== undefined) input.exclude = stringList(value.exclude, `${where}.exclude`, 0);
  } else if (value.kind === 'command') {
    onlyKeys(value, ['kind', 'run', 'platforms'], where);
    if (typeof value.run !== 'string' || value.run.length === 0)
      throw new BuildCacheConfigError(`${where}.run must be a non-empty string`);
    input = { kind: 'command', run: value.run };
  } else {
    throw new BuildCacheConfigError(`${where}.kind must be 'files' or 'command'`);
  }
  if (value.platforms !== undefined) input.platforms = parsePlatforms(value.platforms, `${where}.platforms`);
  return input;
}

export function parseBuildCacheConfig(value: unknown, where = 'buildCache'): BuildCacheConfig {
  if (!isRecord(value)) throw new BuildCacheConfigError(`${where} must be an object`);
  onlyKeys(value, ['inputs', 'cacheableVariants', 'envFile', 'maxAgeDays', 'maxEntries'], where);
  if (!Array.isArray(value.inputs) || value.inputs.length === 0) {
    throw new BuildCacheConfigError(`${where}.inputs must be a list with at least 1 item`);
  }
  const config: BuildCacheConfig = {
    inputs: value.inputs.map((input, i) => parseInput(input, `${where}.inputs[${String(i)}]`)),
    cacheableVariants: stringList(value.cacheableVariants, `${where}.cacheableVariants`, 0),
  };
  if (value.envFile !== undefined) {
    if (typeof value.envFile !== 'string' || value.envFile.length === 0)
      throw new BuildCacheConfigError(`${where}.envFile must be a non-empty string`);
    config.envFile = value.envFile;
  }
  if (value.maxAgeDays !== undefined) {
    if (typeof value.maxAgeDays !== 'number' || !(value.maxAgeDays > 0)) {
      throw new BuildCacheConfigError(`${where}.maxAgeDays must be a number above 0`);
    }
    config.maxAgeDays = value.maxAgeDays;
  }
  if (value.maxEntries !== undefined) {
    if (typeof value.maxEntries !== 'number' || !Number.isInteger(value.maxEntries) || value.maxEntries < 1) {
      throw new BuildCacheConfigError(`${where}.maxEntries must be an integer of at least 1`);
    }
    config.maxEntries = value.maxEntries;
  }
  return config;
}
