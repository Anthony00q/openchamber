import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const infoSchema = z.object({ version: versionSchema });
const legacyHealthSchema = z.object({ version: versionSchema, healthy: z.boolean() });

export const isSupportedOpenCodeVersion = (version) => versionSchema.safeParse(version).success && version.split('.')[0] === '2';

export const readOpenCodeInfo = async (response) => {
  if (!response.ok) return null;
  const parsed = infoSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
};

export const readOpenCodeCliVersion = async (launch, options = {}) => {
  const { stdout } = await execute(launch.binary, [...launch.args, '--version'], {
    ...options, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true,
  });
  const match = /^(?:opencode\s+v?)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(stdout.trim());
  if (!match) throw new Error('Could not determine the installed OpenCode version.');
  return match[1];
};

export class UnsupportedOpenCodeVersionError extends Error {
  constructor(version) {
    super(`OpenCode ${version} is installed. OpenChamber requires OpenCode 2.x.`);
    this.name = 'UnsupportedOpenCodeVersionError';
    this.version = version;
  }
}

export const requireOpenCodeV2 = async (launch, options) => {
  const version = await readOpenCodeCliVersion(launch, options);
  if (!isSupportedOpenCodeVersion(version)) throw new UnsupportedOpenCodeVersionError(version);
  return version;
};

// External URLs have no local executable. A legacy probe identifies v1 only
// from its JSON contract; neither HTML fallbacks nor auth failures imply v1.
export const readExternalOpenCodeVersion = async (baseUrl, headers, fetchImpl = fetch) => {
  const request = (pathname) => fetchImpl(new URL(pathname, baseUrl), {
    headers: { ...headers, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  const response = await request('/api/info');
  if (response.status === 401 || response.status === 403) return null;
  const info = await readOpenCodeInfo(response);
  if (info) return info.version;
  const legacy = await request('/global/health');
  if (!legacy.ok) return null;
  const parsed = legacyHealthSchema.safeParse(await legacy.json().catch(() => null));
  return parsed.success && parsed.data.version.startsWith('1.') ? parsed.data.version : null;
};

export const describeOpenCodeCompatibility = (version, installation, canInstall) => ({
  state: version === null ? 'unavailable' : isSupportedOpenCodeVersion(version) ? 'compatible' : 'incompatible',
  version,
  installation,
  canInstall: version !== null && version.startsWith('1.') && installation === 'managed' && canInstall,
});
