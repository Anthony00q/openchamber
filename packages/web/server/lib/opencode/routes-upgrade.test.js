import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const supportedCapability = { supported: true, manager: 'opencode', reason: null };

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    getOpenCodeUpgradeCapability: () => ({
      supported: false,
      manager: 'openchamber',
      reason: 'bundled',
    }),
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenCode upgrade routes', () => {
  it('fails closed without contacting the bundled OpenCode updater', async () => {
    globalThis.fetch = vi.fn();
    const { app } = createApp();

    await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(409, {
        success: false,
        code: 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER',
        error: 'OpenCode is bundled with OpenChamber Desktop and updates with the app.',
      });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('never announces a newer version for a bundled binary: it updates with the desktop app', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('registry.npmjs.org')) return jsonResponse({ version: '2.0.3' });
      if (String(url).includes('api.github.com')) return jsonResponse({ tag_name: 'v2.0.3' });
      return jsonResponse({ version: '1.18.8', pid: 1, urls: [], paths: { tmp: '/tmp' } });
    });
    const { app } = createApp();

    const response = await request(app)
      .get('/api/opencode/upgrade-status')
      .expect(200);

    expect(response.body).toEqual({
      available: false,
      currentVersion: '1.18.8',
      latestVersion: '2.0.3',
      upgrade: {
        supported: false,
        manager: 'openchamber',
        reason: 'bundled',
      },
    });
  });

  it('tells the user to run OpenCode\'s own installer, and contacts nothing', async () => {
    // v1 exposed `POST /global/upgrade` and OpenChamber drove it from Settings.
    // OpenCode 2 has no upgrade route, so the honest answer is what to do next.
    globalThis.fetch = vi.fn();
    const { app, dependencies } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(409);

    expect(response.body).toMatchObject({
      success: false,
      code: 'OPENCODE_UPGRADE_UNSUPPORTED',
    });
    expect(response.body.error).toMatch(/installer/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(dependencies.refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
  });

  it('ignores an explicitly requested target, because there is nothing to drive', async () => {
    globalThis.fetch = vi.fn();
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });

    await request(app)
      .post('/api/opencode/upgrade')
      .send({ target: '2.1.0' })
      .expect(409);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
