export function supportsOpenCodeV2Install(): boolean;
export function installOpenCodeV2(options?: {
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<string>;
