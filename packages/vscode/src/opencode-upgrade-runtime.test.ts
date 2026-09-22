import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenCodeUpgradeStatus, upgradeManagedOpenCode, type OpenCodeUpgradeManager } from './opencode-upgrade-runtime';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createManager = (mode: 'managed' | 'external' = 'managed'): OpenCodeUpgradeManager => ({
  getApiUrl: () => 'http://127.0.0.1:4096',
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
  getDebugInfo: () => ({ mode }),
});

describe('VS Code OpenCode upgrades', () => {
  test('reports installed and latest versions from the v2 info route', async () => {
    const manager = createManager();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: '2.0.1', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
      if (url.includes('registry.npmjs.org')) return new Response(JSON.stringify({ version: '2.0.2' }));
      return new Response(JSON.stringify({ tag_name: 'v2.0.2' }));
    }) as typeof fetch;

    assert.deepEqual(await getOpenCodeUpgradeStatus(manager), {
      available: true,
      currentVersion: '2.0.1',
      latestVersion: '2.0.2',
      upgrade: { supported: false, manager: 'opencode', reason: 'no-upgrade-route' },
    });
  });

  test('still reports the running version for an externally managed OpenCode', async () => {
    const manager = createManager('external');
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return new Response(JSON.stringify({ version: '2.0.2', pid: 1, urls: [], paths: { tmp: '/tmp' } }));
      return new Response(JSON.stringify({ version: '2.0.2' }));
    }) as typeof fetch;

    const status = await getOpenCodeUpgradeStatus(manager);
    assert.equal(status.currentVersion, '2.0.2');
    assert.deepEqual(status.upgrade, { supported: false, manager: 'external', reason: 'external' });
  });

  test('answers unsupported without contacting OpenCode, which has no upgrade route in 2.x', async () => {
    const manager = createManager();
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('{}');
    }) as typeof fetch;

    const result = await upgradeManagedOpenCode(manager);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'OPENCODE_UPGRADE_UNSUPPORTED');
    assert.equal(fetchCount, 0);
  });
});
