export interface MaestroRelease {
  version: string;
  asset: string;
  size: number;
  sha256: string;
  url: string;
}

export const MAESTRO_RELEASE: MaestroRelease = {
  version: '2.11.0-agentlane.1',
  asset: 'maestro-2.11.0-agentlane.1.zip',
  size: 314_868_792,
  sha256: 'c79f6b2960eb2af7cb39953b1f9a8c77cd068d9c5b95d6a49f29eccc47e5f308',
  url: 'https://github.com/north-star-hq/agentlane/releases/download/maestro-v2.11.0-agentlane.1/maestro-2.11.0-agentlane.1.zip',
};
