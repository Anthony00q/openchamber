import { describe, expect, it } from 'vitest';
import { fetchQuota, isConfigured } from './command-code.js';

const readAuth = () => ({ 'command-code': { key: 'test-token' } });

// Shape assembled from the community implementations that read the same
// CLI-internal endpoints (cmdcode2api, commandcode-usage): whoami carries the
// org scope, billing/credits the balances and rolling windows.
const personalWhoami = { user: { name: 'dev' }, org: null };
const orgWhoami = { data: { user: { name: 'dev' }, org: { id: 'org-1' } } };
const creditsPayload = {
  credits: { monthlyCredits: 50, purchasedCredits: 10, freeCredits: 0, planId: 'individual-pro-v1' },
  windowLimits: {
    fiveHour: { used: 4, cap: 16, resetAt: '2026-09-23T20:00:00.000Z' },
    weekly: { used: 10, cap: 40, reset_at: 1784491827000 }
  }
};

const fetchSequence = (routes) => async (url, options) => {
  expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token');
  expect(options.signal).toBeInstanceOf(AbortSignal);
  for (const [match, response] of routes) {
    if (url.includes(match)) return response;
  }
  throw new Error(`Unexpected quota request: ${url}`);
};

describe('Command Code quota provider', () => {
  it('resolves a personal account without org scope and maps windows plus monthly balance', async () => {
    const seen = [];
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', Response.json(creditsPayload)],
      ['/alpha/billing/subscriptions', Response.json({ data: { planId: 'individual-pro-v1', status: 'active' } })]
    ]) });

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('command-code');
    expect(result.planLabel).toBe('Pro');
    expect(result.usage.windows['5h'].usedPercent).toBe(25);
    expect(result.usage.windows['5h'].remainingPercent).toBe(75);
    expect(result.usage.windows['5h'].windowSeconds).toBe(18_000);
    expect(result.usage.windows['5h'].resetAt).toBe(Date.parse('2026-09-23T20:00:00.000Z'));
    expect(result.usage.windows.weekly.usedPercent).toBe(25);
    expect(result.usage.windows.weekly.windowSeconds).toBe(604_800);
    expect(result.usage.windows.monthly_credits.valueLabel).toBe('$50.00');
    expect(result.usage.windows.monthly_credits.usedPercent).toBeNull();
    expect(result.usage.windows.purchased_credits).toBeUndefined();
    expect(result.usage.windows.free_credits).toBeUndefined();
    expect(JSON.stringify({ seen, result })).not.toContain('test-token');
  });

  it('passes the org id to subscriptions for organization accounts', async () => {
    const requested = [];
    const result = await fetchQuota({ readAuth, fetchImpl: async (url, options) => {
      requested.push(url);
      return fetchSequence([
        ['/alpha/whoami', Response.json(orgWhoami)],
        ['/alpha/billing/credits', Response.json(creditsPayload)],
        ['/alpha/billing/subscriptions', Response.json({ data: { planId: 'teams-pro', status: 'active' } })]
      ])(url, options);
    } });

    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('Teams Pro');
    expect(requested.find((url) => url.includes('/alpha/billing/subscriptions'))).toContain('orgId=org-1');
    expect(requested.find((url) => url.includes('/alpha/billing/credits'))).not.toContain('orgId');
  });

  it('accepts the commandcode auth spelling, OAuth access, and the env credential', async () => {
    for (const auth of [
      { commandcode: { key: 'test-token' } },
      { 'command-code': { access: 'test-token', type: 'oauth' } }
    ]) {
      expect(isConfigured(auth)).toBe(true);
      const result = await fetchQuota({ readAuth: () => auth, fetchImpl: fetchSequence([
        ['/alpha/whoami', Response.json(personalWhoami)],
        ['/alpha/billing/credits', Response.json(creditsPayload)],
        ['/alpha/billing/subscriptions', Response.json({})]
      ]) });
      expect(result.ok).toBe(true);
    }
    process.env.COMMAND_CODE_API_KEY = 'test-token';
    try {
      expect(isConfigured({})).toBe(true);
      const result = await fetchQuota({ readAuth: () => ({}), fetchImpl: fetchSequence([
        ['/alpha/whoami', Response.json(personalWhoami)],
        ['/alpha/billing/credits', Response.json(creditsPayload)],
        ['/alpha/billing/subscriptions', Response.json({})]
      ]) });
      expect(result.ok).toBe(true);
      expect(result.planLabel).toBe('Pro');
    } finally {
      delete process.env.COMMAND_CODE_API_KEY;
    }
  });

  it('resolves every logo-fallback id spelling', async () => {
    for (const id of ['command-code', 'commandcode', 'command_code', 'command code']) {
      expect(isConfigured({ [id]: { key: 'test-token' } })).toBe(true);
      const result = await fetchQuota({ readAuth: () => ({ [id]: { key: 'test-token' } }), fetchImpl: fetchSequence([
        ['/alpha/whoami', Response.json(personalWhoami)],
        ['/alpha/billing/credits', Response.json(creditsPayload)],
        ['/alpha/billing/subscriptions', Response.json({})]
      ]) });
      expect(result.ok).toBe(true);
      expect(result.providerId).toBe('command-code');
    }
  });

  it('stays successful with balance-only data when windows are absent (Provider plan)', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', Response.json({ data: { credits: { monthly_credits: 5 } } })],
      ['/alpha/billing/subscriptions', new Response(null, { status: 404 })]
    ]) });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['monthly_credits']);
    expect(result.usage.windows.monthly_credits.usedPercent).toBeNull();
    expect(result.planLabel ?? null).toBeNull();
  });

  it('keeps windows when subscriptions fails but reports failure when credits fails', async () => {
    const degraded = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', Response.json(creditsPayload)],
      ['/alpha/billing/subscriptions', new Response(null, { status: 503 })]
    ]) });
    expect(degraded.ok).toBe(true);
    expect(degraded.usage.windows['5h'].usedPercent).toBe(25);

    const failed = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', new Response(null, { status: 503 })],
      ['/alpha/billing/subscriptions', Response.json({})]
    ]) });
    expect(failed.ok).toBe(false);
    expect(failed.usage).toBeNull();
    expect(failed.error).toBe('API error: 503');
  });

  it.each([{}, { 'command-code': { key: '' } }, { 'command-code': { key: 42 } }])('does not fetch without usable credentials: %j', async (auth) => {
    expect(isConfigured(auth)).toBe(false);
    const result = await fetchQuota({ readAuth: () => auth, fetchImpl: async () => { throw new Error('Unexpected fetch'); } });
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it('reports an expired session on 401 from either endpoint', async () => {
    for (const failing of ['/alpha/whoami', '/alpha/billing/credits']) {
      const result = await fetchQuota({ readAuth, fetchImpl: async (url, options) => {
        if (url.includes(failing)) return new Response(null, { status: 401 });
        return fetchSequence([
          ['/alpha/whoami', Response.json(personalWhoami)],
          ['/alpha/billing/credits', Response.json(creditsPayload)],
          ['/alpha/billing/subscriptions', Response.json({})]
        ])(url, options);
      } });
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.error).toBe('Session expired — please re-authenticate with Command Code');
    }
  });

  it.each([{}, { credits: null }, { windowLimits: {} }])('rejects empty or malformed credits payload %j', async (payload) => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', Response.json(payload)],
      ['/alpha/billing/subscriptions', Response.json({})]
    ]) });
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('No quota data in response');
  });

  it('rejects a null credits payload', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', { ok: true, status: 200, json: async () => null }],
      ['/alpha/billing/subscriptions', Response.json({})]
    ]) });
    expect(result.ok).toBe(false);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('No quota data in response');
  });

  it('ignores malformed windows without discarding valid siblings', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', Response.json({
        credits: { monthlyCredits: 50 },
        windowLimits: {
          fiveHour: { used: 'NaN', cap: 16 },
          weekly: { used: 10, cap: 40 }
        }
      })],
      ['/alpha/billing/subscriptions', Response.json({})]
    ]) });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['weekly', 'monthly_credits']);
  });

  it('omits purchased and free balances, showing 5h, weekly, and monthly only', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', Response.json({
        credits: { monthlyCredits: 50, purchasedCredits: 10, freeCredits: 5 },
        windowLimits: {
          fiveHour: { used: 4, cap: 16 },
          weekly: { used: 10, cap: 40 }
        }
      })],
      ['/alpha/billing/subscriptions', Response.json({})]
    ]) });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.windows)).toEqual(['5h', 'weekly', 'monthly_credits']);
  });

  it('reports an unknown plan verbatim instead of hiding data', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', Response.json(creditsPayload)],
      ['/alpha/billing/subscriptions', Response.json({ data: { planId: 'individual-future' } })]
    ]) });
    expect(result.ok).toBe(true);
    expect(result.planLabel).toBe('individual-future');
  });

  it('reports invalid JSON', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', Response.json(personalWhoami)],
      ['/alpha/billing/credits', { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }],
      ['/alpha/billing/subscriptions', Response.json({})]
    ]) });
    expect(result.error).toBe('Invalid response from provider');
  });

  it('recognizes the timeout exception from AbortSignal.timeout', async () => {
    const result = await fetchQuota({ readAuth, fetchImpl: fetchSequence([
      ['/alpha/whoami', { ok: true, status: 200, json: async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); } }],
      ['/alpha/billing/credits', Response.json(creditsPayload)],
      ['/alpha/billing/subscriptions', Response.json({})]
    ]) });
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.usage).toBeNull();
    expect(result.error).toBe('Request timed out');
  });
});
