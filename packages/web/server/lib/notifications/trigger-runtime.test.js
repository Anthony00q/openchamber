import { describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

/**
 * The "ready" push is built from the translated `message.updated` events.
 * v2 splits a turn: the step start names agent and model, the step end
 * carries the finish. What is pinned here: the finish is announced with the
 * agent and model from the start, a user abort announces nothing, and an
 * active goal (which lives in OpenChamber's own metadata) silences the push.
 */
const makeRuntime = ({ metadata = {} } = {}) => {
  const emitDesktopNotification = vi.fn(() => true);
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnCompletion: true }),
    prepareNotificationLastMessage: async ({ message }) => message,
    buildTemplateVariables: async () => ({}),
    extractLastMessageText: () => 'done',
    fetchLastAssistantMessageText: async () => 'done',
    resolveNotificationTemplate: () => '',
    shouldApplyResolvedTemplateMessage: () => false,
    emitDesktopNotification,
    broadcastUiNotification: vi.fn(),
    sendPushToAllUiSessions: vi.fn(async () => undefined),
    sendApnsToAllUiSessions: vi.fn(async () => undefined),
    isAnyInteractiveClientVisible: () => true,
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    readSessionMetadata: async () => metadata,
  });
  return { runtime, emitDesktopNotification };
};

const stepStarted = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', agent: 'build', providerID: 'anthropic', modelID: 'claude-sonnet-5', time: { created: 1 } } },
});
const stepEnded = (sessionID, id) => ({
  type: 'message.updated',
  properties: { sessionID, info: { id, sessionID, role: 'assistant', finish: 'stop', time: { completed: 2 } } },
});

describe('ready notification on v2 step events', () => {
  it('names the agent and model from the step start when the finish arrives', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger(stepStarted('ses_1', 'msg_1'));
    expect(emitDesktopNotification).not.toHaveBeenCalled();

    await runtime.maybeSendPushForTrigger(stepEnded('ses_1', 'msg_1'));
    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    expect(emitDesktopNotification.mock.calls[0][0]).toMatchObject({
      kind: 'ready',
      title: 'Build agent is ready',
      body: 'Claude Sonnet 5 completed the task',
    });
  });

  it('announces nothing for a user abort', async () => {
    const { runtime, emitDesktopNotification } = makeRuntime();

    await runtime.maybeSendPushForTrigger({
      type: 'session.idle',
      properties: { sessionID: 'ses_2', aborted: true, reason: 'user', error: { name: 'MessageAbortedError', message: 'aborted' } },
    });

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });

  it('stays quiet while a goal from OpenChamber\'s own metadata is active', async () => {
    const { runtime, emitDesktopNotification } = makeRuntime({
      metadata: { openchamber: { goal: { id: 'g', status: 'active', objective: 'x' } } },
    });

    await runtime.maybeSendPushForTrigger(stepStarted('ses_3', 'msg_3'));
    await runtime.maybeSendPushForTrigger(stepEnded('ses_3', 'msg_3'));

    expect(emitDesktopNotification).not.toHaveBeenCalled();
  });
});
