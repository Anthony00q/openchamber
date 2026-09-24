import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  asObject,
  asNonEmptyString,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  formatMoney
} from '../utils/index.js';

export const providerId = 'command-code';
export const providerName = 'Command Code';
// Spellings recognized by the model-picker logo fallback: quota resolves the
// same ids so the tile and the logo never disagree about Command Code.
export const aliases = ['command-code', 'commandcode', 'command_code', 'command code'];
const COMMAND_CODE_API_BASE = 'https://api.commandcode.ai';
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

// Reverse-engineered from the official CLI by the community; Command Code
// documents plans and limits but not the subscription payload. Unknown plan
// ids are reported verbatim so a new plan never hides quota data.
const KNOWN_PLANS = [
  ['individual-pro-v1', 'Pro'],
  ['individual-pro', 'Pro'],
  ['individual-goat', 'GOAT'],
  ['individual-go', 'Go'],
  ['individual-provider', 'Provider'],
  ['individual-max', 'Max'],
  ['individual-ultra', 'Ultra'],
  ['teams-pro', 'Teams Pro']
];

const resolvePlanLabel = (planId) => {
  const id = asNonEmptyString(planId);
  if (!id) return null;
  const normalized = id.toLowerCase().replace(/_/g, '-');
  for (const [prefix, name] of KNOWN_PLANS) {
    if (normalized.startsWith(prefix)) return name;
  }
  return id;
};

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return asNonEmptyString(entry?.access)
    ?? asNonEmptyString(entry?.key)
    ?? asNonEmptyString(entry?.token)
    ?? asNonEmptyString(process.env.COMMAND_CODE_API_KEY);
};

export const isConfigured = (auth = readAuthFile()) => Boolean(getApiKey(auth));

const firstDefined = (obj, keys) => {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
};

// The /alpha endpoints are CLI-internal and undocumented: accept camelCase or
// snake_case keys, epoch seconds/milliseconds or ISO timestamps, and payloads
// either flat or wrapped in `data`. Anything unrecognized is skipped, never
// guessed at.
const parseServerWindow = (raw) => {
  const window = asObject(raw);
  if (!window) return null;
  const used = toNumber(firstDefined(window, ['used', 'usage', 'usedCredits', 'used_credits']));
  const cap = toNumber(firstDefined(window, ['cap', 'limit', 'capCredits', 'cap_credits']));
  if (used === null || cap === null || cap <= 0) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, (used / cap) * 100)),
    resetAt: toTimestamp(firstDefined(window, ['resetAt', 'reset_at', 'resetsAt', 'resets_at']))
  };
};

const requestJson = async (fetchImpl, url, apiKey, signal) => {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Accept-Encoding': 'identity'
    },
    signal
  });
  if (!response.ok) {
    const error = new Error(`API error: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

export const fetchQuota = async ({ readAuth = readAuthFile, fetchImpl = fetch } = {}) => {
  const apiKey = getApiKey(readAuth());

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);
  const isTimeoutError = (error) => error instanceof DOMException && (
    error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
  );
  const isParseError = (error) => error instanceof SyntaxError;

  try {
    // 1. whoami resolves the account scope for the subscriptions query.
    // Personal accounts return `org: null` and need no org parameter.
    let orgId = null;
    try {
      const whoami = await requestJson(fetchImpl, `${COMMAND_CODE_API_BASE}/alpha/whoami`, apiKey, timeoutSignal);
      const whoamiRoot = asObject(whoami?.data) ?? asObject(whoami);
      orgId = asNonEmptyString(asObject(whoamiRoot?.org)?.id);
    } catch (error) {
      if (error?.status === 401 || error?.status === 403) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'Session expired — please re-authenticate with Command Code'
        });
      }
      // A failed whoami only loses the org scope — unless it was a timeout or
      // a malformed payload, in which case the failure must stay visible.
      if (isTimeoutError(error) || isParseError(error)) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: isTimeoutError(error) ? 'Request timed out' : 'Invalid response from provider'
        });
      }
    }

    // 2. billing/credits carries balances and the 5-hour/weekly windows.
    let creditsPayload;
    try {
      creditsPayload = await requestJson(fetchImpl, `${COMMAND_CODE_API_BASE}/alpha/billing/credits`, apiKey, timeoutSignal);
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: error?.status === 401 || error?.status === 403
          ? 'Session expired — please re-authenticate with Command Code'
          : isTimeoutError(error)
            ? 'Request timed out'
            : isParseError(error)
              ? 'Invalid response from provider'
              : (error instanceof Error ? error.message : 'Request failed')
      });
    }

    const creditsRoot = asObject(creditsPayload?.data) ?? asObject(creditsPayload);
    const credits = asObject(creditsPayload?.credits)
      ?? asObject(creditsRoot?.credits);
    const windowLimits = asObject(creditsPayload?.windowLimits)
      ?? asObject(creditsPayload?.window_limits)
      ?? asObject(creditsRoot?.windowLimits)
      ?? asObject(creditsRoot?.window_limits);

    const windows = {};
    const fiveHour = parseServerWindow(
      firstDefined(windowLimits ?? {}, ['fiveHour', 'five_hour', 'rolling5h', '5h'])
    );
    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: fiveHour.usedPercent,
        windowSeconds: FIVE_HOUR_SECONDS,
        resetAt: fiveHour.resetAt
      });
    }
    const weekly = parseServerWindow(firstDefined(windowLimits ?? {}, ['weekly', 'week']));
    if (weekly) {
      windows.weekly = toUsageWindow({
        usedPercent: weekly.usedPercent,
        windowSeconds: WEEK_SECONDS,
        resetAt: weekly.resetAt
      });
    }

    // Only the monthly balance is surfaced: purchased and free balances are
    // intentionally omitted so Usage shows 5h, weekly, and monthly only.
    const monthlyBalance = credits ? toNumber(firstDefined(credits, ['monthlyCredits', 'monthly_credits'])) : null;
    if (monthlyBalance !== null) {
      windows.monthly_credits = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(monthlyBalance)}`
      });
    }

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    // 3. billing/subscriptions carries the plan and billing period. Optional:
    // losing it costs the plan label, not the quota data.
    let planLabel = resolvePlanLabel(credits ? firstDefined(credits, ['planId', 'plan_id']) : null);
    try {
      const subscriptionsUrl = orgId
        ? `${COMMAND_CODE_API_BASE}/alpha/billing/subscriptions?orgId=${encodeURIComponent(orgId)}`
        : `${COMMAND_CODE_API_BASE}/alpha/billing/subscriptions`;
      const subscriptionsPayload = await requestJson(fetchImpl, subscriptionsUrl, apiKey, timeoutSignal);
      const subscriptionsRoot = asObject(subscriptionsPayload?.data)
        ?? asObject(subscriptionsPayload?.subscription)
        ?? asObject(subscriptionsPayload);
      const subscriptionLabel = resolvePlanLabel(firstDefined(subscriptionsRoot ?? {}, ['planId', 'plan_id']));
      if (subscriptionLabel) planLabel = subscriptionLabel;
    } catch {
      // Keep the windows without a plan label.
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      planLabel
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeoutError(error)
        ? 'Request timed out'
        : isParseError(error)
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};
