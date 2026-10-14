export interface MaestroRelease {
  version: string;
  repo: string;
  tag: string;
  asset: string;
  size: number;
  sha256: string;
  url: string;
  download: 'gh' | 'https';
}

export const MAESTRO_RELEASE: MaestroRelease = {
  version: '2.11.0-agentenv.3',
  repo: 'north-star-hq/agent-env',
  tag: 'maestro-v2.11.0-agentenv.3',
  asset: 'maestro-2.11.0-agentenv.3.zip',
  size: 314_867_260,
  sha256: '270330d408f0bfc43fec761c666dae802efda681cda261d7bf778caf549f7103',
  url: 'https://github.com/north-star-hq/agent-env/releases/download/maestro-v2.11.0-agentenv.3/maestro-2.11.0-agentenv.3.zip',
  download: 'gh',
};
