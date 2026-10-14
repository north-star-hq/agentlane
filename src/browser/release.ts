/** A package from the npm registry, checked against the integrity the registry published for it. */
export interface PackagePin {
  name: string;
  version: string;
  tarball: string;
  /** The registry's `dist.integrity`: sha512, base64. */
  sha512: string;
}

/** A download checked by its size and sha256, both measured when the pin was made. */
export interface ArchivePin {
  url: string;
  size: number;
  sha256: string;
  /** The executable inside, relative to the folder the archive unpacks into. */
  executable: string[];
}

/** A browser build in Playwright's own layout: `<name with underscores>-<revision>` under PLAYWRIGHT_BROWSERS_PATH. */
export interface BrowserBuild {
  name: 'chromium' | 'chromium-headless-shell' | 'ffmpeg';
  revision: string;
  /** By host, `<os>-<arch>` as Node names them. A host without an entry has no pinned build. */
  archives: Partial<Record<string, ArchivePin>>;
}

export interface PlaywrightRelease {
  version: string;
  core: PackagePin;
  browsers: BrowserBuild[];
}

export interface AgentBrowserRelease {
  version: string;
  package: PackagePin;
  /** The native binary for each host, inside the package. */
  binaries: Partial<Record<string, string>>;
}

// playwright-core carries playwright-cli itself (lib/tools/cli-client): the CLI, its daemon and the browser registry.
export const PLAYWRIGHT_RELEASE: PlaywrightRelease = {
  version: '1.64.0',
  core: {
    name: 'playwright-core',
    version: '1.64.0',
    tarball: 'https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.0.tgz',
    sha512: 'T9r+MZkTECl2+oUcZ26YgZzTrYidTsIhYYkJix+6iDOymOb1FB2RLLSOxRGnZGv5DStt+aduIVbt+E8WygXYpg==',
  },
  browsers: [
    {
      name: 'chromium',
      revision: '1248',
      archives: {
        'darwin-arm64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/mac-arm64/chrome-mac-arm64.zip',
          size: 194_831_853,
          sha256: '987d2f8499c87d21676f78178550cfcbfb1bb53786821e2cff46c5a7e99b58be',
          executable: ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
        },
        'darwin-x64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/mac-x64/chrome-mac-x64.zip',
          size: 205_332_100,
          sha256: '4e75da96830224185ddddc80012ad3732d6a29a4f92bac728c84c8e8ebd66c34',
          executable: ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
        },
        'linux-arm64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux-arm64/chrome-linux-arm64.zip',
          size: 199_750_508,
          sha256: '910a12fff6170202195f72ef3d353801c7063d301ab80b1f51b77d791fda60ce',
          executable: ['chrome-linux-arm64', 'chrome'],
        },
        'linux-x64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-linux64.zip',
          size: 200_345_244,
          sha256: '43fd31766c7533a02dda2ded5ad50c2f861cd5400be7509c0abad71129f79d79',
          executable: ['chrome-linux64', 'chrome'],
        },
      },
    },
    {
      name: 'chromium-headless-shell',
      revision: '1248',
      archives: {
        'darwin-arm64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/mac-arm64/chrome-headless-shell-mac-arm64.zip',
          size: 103_778_487,
          sha256: '94e4337b70cbc5638f0935fbc46b9f242bc7416f657e3fbe924baf348404b53d',
          executable: ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        },
        'darwin-x64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/mac-x64/chrome-headless-shell-mac-x64.zip',
          size: 109_130_614,
          sha256: '8a9e4a32ba5b1a796f8b16d01896e355cf6662544d9743296394fd999d782331',
          executable: ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
        },
        'linux-arm64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux-arm64/chrome-headless-shell-linux-arm64.zip',
          size: 125_711_061,
          sha256: '81ab9d4d3c301dc5fdfb6c541b9e6632b16fc819a6a854460f40a76fe2b2c476',
          executable: ['chrome-headless-shell-linux-arm64', 'chrome-headless-shell'],
        },
        'linux-x64': {
          url: 'https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux64/chrome-headless-shell-linux64.zip',
          size: 125_797_539,
          sha256: 'c3e50596aef52c58f8fda3c6b3411c33d34c88b177b3ed1c2243359fd3b8ba20',
          executable: ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
        },
      },
    },
    {
      name: 'ffmpeg',
      revision: '1013',
      archives: {
        'darwin-arm64': {
          url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-mac-arm64.zip',
          size: 1_430_308,
          sha256: '63e48ce8d4a6d9d496383e5ac557b26466e719fa29126bbbd5f5f7016ac9229c',
          executable: ['ffmpeg-mac'],
        },
        'darwin-x64': {
          url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-mac.zip',
          size: 1_549_708,
          sha256: 'ffdf08ab13def2b63e81ed9782e39debc5bd498220e8e134f9a36e984db6d9db',
          executable: ['ffmpeg-mac'],
        },
        'linux-arm64': {
          url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-linux-arm64.zip',
          size: 2_037_513,
          sha256: '457360e803a7d8d5f8f7f5ecf562b2d338f6b4f7f86339d0c31938a451e8878b',
          executable: ['ffmpeg-linux'],
        },
        'linux-x64': {
          url: 'https://cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1013/ffmpeg-linux.zip',
          size: 2_302_701,
          sha256: 'ee986434d158f74fb5d9c5ff1092026ceedb63f324fe90b5be89460926b7b679',
          executable: ['ffmpeg-linux'],
        },
      },
    },
  ],
};

// agent-browser's npm package carries the native binary for every host, so the package's integrity covers it.
export const AGENT_BROWSER_RELEASE: AgentBrowserRelease = {
  version: '0.39.0',
  package: {
    name: 'agent-browser',
    version: '0.39.0',
    tarball: 'https://registry.npmjs.org/agent-browser/-/agent-browser-0.39.0.tgz',
    sha512: 'VtImIqCpHC/xJFw91IAcLlBJzebCBjynOwIKnx4kuCeI2JicpPBMKykdjQ1wmnj2dL2voNKRv8iK+Joe6aHFtw==',
  },
  binaries: {
    'darwin-arm64': 'bin/agent-browser-darwin-arm64',
    'darwin-x64': 'bin/agent-browser-darwin-x64',
    'linux-arm64': 'bin/agent-browser-linux-arm64',
    'linux-x64': 'bin/agent-browser-linux-x64',
  },
};

export function hostKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}
