type UpgradeCapability = {
  supported: boolean;
  manager: 'opencode' | 'external' | 'openchamber' | null;
  reason: 'external' | 'unavailable' | 'windows-arm64-workaround' | 'no-upgrade-route' | null;
};

export type OpenCodeUpgradeManager = {
  getApiUrl(): string | null;
  getOpenCodeAuthHeaders(): Record<string, string>;
  getDebugInfo(): { mode: 'managed' | 'external' };
};

type UpgradeResult = { status: number; body: Record<string, unknown> };

// TEMPORARY WORKAROUND — Windows ARM64: native opencode.exe fails with a Bun
// FFI/TinyCC dlopen error (https://github.com/anomalyco/opencode/issues/19130).
// Disable OpenCode self-upgrade on ARM64 so it can't overwrite the working x64
// binary with the broken ARM64 build. Remove when the upstream issue is resolved.
const isWindowsArm64 = (): boolean => process.platform === 'win32' && process.arch === 'arm64';

const parseVersion = (value: unknown): { parts: number[]; prerelease: boolean } => {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  return {
    parts: core.split('.').map((part) => {
      const parsed = Number.parseInt(part || '0', 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease: prereleaseIndex >= 0,
  };
};

const compareVersions = (left: unknown, right: unknown): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (difference !== 0) return difference;
  }
  return a.prerelease === b.prerelease ? 0 : (a.prerelease ? -1 : 1);
};

// OpenCode 2.x dropped the server-side upgrade route, so nothing OpenChamber
// can call upgrades a managed OpenCode from inside the extension any more. The
// status read below still reports the installed and latest versions; the user
// upgrades OpenCode with their own installer.
const getCapability = (manager?: OpenCodeUpgradeManager): UpgradeCapability => {
  if (isWindowsArm64()) return { supported: false, manager: 'openchamber', reason: 'windows-arm64-workaround' };
  if (!manager) return { supported: false, manager: null, reason: 'unavailable' };
  if (manager.getDebugInfo().mode !== 'managed') return { supported: false, manager: 'external', reason: 'external' };
  if (!manager.getApiUrl()) return { supported: false, manager: null, reason: 'unavailable' };
  return { supported: false, manager: 'opencode', reason: 'no-upgrade-route' };
};

const getApiUrl = (manager?: OpenCodeUpgradeManager): string | null => {
  const apiUrl = manager?.getApiUrl();
  return apiUrl ? `${apiUrl.replace(/\/+$/, '')}/` : null;
};

// OpenCode 2.x publishes as `@opencode/cli` on npm and has no GitHub release
// assets, so the registry is the one source of "latest".
const fetchLatestVersion = async (): Promise<string> => {
  const response = await fetch('https://registry.npmjs.org/@opencode%2Fcli/latest', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenCode npm registry responded with ${response.status}`);
  // SAFETY: the registry answers a packument; only `version` is read, and it
  // is checked to be a string before use.
  const payload = await response.json() as { version?: unknown };
  const version = typeof payload.version === 'string' ? payload.version.trim().replace(/^v/, '') : '';
  if (!version) throw new Error('Failed to resolve latest OpenCode version');
  return version;
};

export const getOpenCodeUpgradeStatus = async (manager?: OpenCodeUpgradeManager): Promise<Record<string, unknown>> => {
  const upgrade = getCapability(manager);
  const apiUrl = getApiUrl(manager);
  // Version reporting does not depend on being able to upgrade: About still
  // shows which OpenCode is running even though the upgrade action is gone.
  if (!apiUrl || !manager) return { available: false, currentVersion: null, latestVersion: null, upgrade };
  try {
    const [healthResponse, latestVersion] = await Promise.all([
      // OpenCode 2.0.8 replaced `/api/health` with `/api/info`.
      fetch(new URL('/api/info', apiUrl).toString(), { method: 'GET', headers: { Accept: 'application/json', ...manager.getOpenCodeAuthHeaders() } }),
      fetchLatestVersion(),
    ]);
    const health = await healthResponse.json().catch(() => null) as { version?: unknown; error?: unknown } | null;
    if (!healthResponse.ok) {
      const error = typeof health?.error === 'string' ? health.error : healthResponse.statusText || 'Failed to read OpenCode version';
      return { available: null, error, upgrade };
    }
    const currentVersion = typeof health?.version === 'string' && health.version.trim() ? health.version.trim().replace(/^v/, '') : null;
    return { available: currentVersion ? compareVersions(latestVersion, currentVersion) > 0 : null, currentVersion, latestVersion, upgrade };
  } catch (error) {
    return { available: null, error: error instanceof Error ? error.message : String(error), upgrade };
  }
};

/**
 * OpenCode 2.x removed the upgrade route it used to expose, so there is nothing
 * left for OpenChamber to drive. Answering explicitly keeps the shared UI on a
 * stable unsupported response instead of a 404 from the proxy.
 */
export const upgradeManagedOpenCode = async (manager?: OpenCodeUpgradeManager): Promise<UpgradeResult> => ({
  status: 409,
  body: {
    success: false,
    code: 'OPENCODE_UPGRADE_UNSUPPORTED',
    error: 'This OpenCode runtime cannot be upgraded by OpenChamber.',
    upgrade: getCapability(manager),
  },
});
