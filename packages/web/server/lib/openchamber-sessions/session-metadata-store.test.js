import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMetadataStore, mergeMetadataPatch } from './session-metadata-store.js';

const tempDirs = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-metadata-'));
  tempDirs.push(dir);
  return dir;
};

const readFile = (dataDir) => fs.readFileSync(path.join(dataDir, 'sessions-metadata.json'), 'utf8');

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('mergeMetadataPatch', () => {
  it('merges nested objects key by key instead of replacing them', () => {
    const current = { openchamber: { goal: { id: 'g1', status: 'active' }, assist: { recap: 'r' } } };
    const merged = mergeMetadataPatch(current, { openchamber: { goal: { status: 'complete' } } });

    expect(merged).toEqual({
      openchamber: { goal: { id: 'g1', status: 'complete' }, assist: { recap: 'r' } },
    });
    // The input is untouched: callers keep whatever they already held.
    expect(current.openchamber.goal.status).toBe('active');
  });

  it('deletes a key when its patch value is null', () => {
    expect(mergeMetadataPatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ openchamber: { goal: {}, assist: {} } }, { openchamber: { assist: null } }))
      .toEqual({ openchamber: { goal: {} } });
  });

  it('replaces arrays and scalars rather than merging into them', () => {
    expect(mergeMetadataPatch({ pins: ['a', 'b'] }, { pins: ['c'] })).toEqual({ pins: ['c'] });
    expect(mergeMetadataPatch({ a: { nested: true } }, { a: 'flat' })).toEqual({ a: 'flat' });
  });

  it('treats a missing or non-object base as empty', () => {
    expect(mergeMetadataPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch('nope', { a: 1 })).toEqual({ a: 1 });
    expect(mergeMetadataPatch({ a: 1 }, 'nope')).toEqual({ a: 1 });
  });
});

describe('createSessionMetadataStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await expect(store.getAll()).resolves.toEqual({});
    await expect(store.get('ses_1')).resolves.toEqual({});
  });

  it('stores a patch, persists it, and reads it back in a fresh store', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });

    const merged = await store.setSessionMetadata('ses_1', { openchamber: { goal: { id: 'g1' } } });
    expect(merged).toEqual({ openchamber: { goal: { id: 'g1' } } });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: { openchamber: { goal: { id: 'g1' } } } });

    const reopened = createSessionMetadataStore({ dataDir });
    await expect(reopened.get('ses_1')).resolves.toEqual({ openchamber: { goal: { id: 'g1' } } });
  });

  it('keeps a neighbouring namespace when another feature writes', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await store.setSessionMetadata('ses_1', { openchamber: { assist: { recap: 'done' } } });
    const merged = await store.setSessionMetadata('ses_1', { openchamber: { goal: { status: 'active' } } });

    expect(merged).toEqual({ openchamber: { assist: { recap: 'done' }, goal: { status: 'active' } } });
  });

  it('keeps an authoritative empty record when a null patch removes the final key', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });
    await store.setSessionMetadata('ses_1', { openchamber: { goal: { id: 'g1' } } });

    await expect(store.setSessionMetadata('ses_1', { openchamber: null })).resolves.toEqual({});
    await expect(store.getAll()).resolves.toEqual({ ses_1: {} });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: {} });
  });

  it('scopes metadata per session', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await store.setSessionMetadata('ses_1', { a: 1 });
    await store.setSessionMetadata('ses_2', { b: 2 });

    await expect(store.getAll()).resolves.toEqual({ ses_1: { a: 1 }, ses_2: { b: 2 } });
  });

  it('rejects a blank session id and a non-object patch', async () => {
    const store = createSessionMetadataStore({ dataDir: makeDataDir() });
    await expect(store.setSessionMetadata('  ', { a: 1 })).rejects.toThrow(/session id is required/);
    await expect(store.setSessionMetadata('ses_1', 'nope')).rejects.toThrow(/must be an object/);
    await expect(store.setSessionMetadata('ses_1', ['a'])).rejects.toThrow(/must be an object/);
  });

  it('writes atomically: the visible file is never a partial payload', async () => {
    const dataDir = makeDataDir();
    const seen = [];
    const fsPromises = {
      ...fs.promises,
      writeFile: async (target, payload, encoding) => {
        // The visible file must still be the previous one at this point.
        seen.push(fs.existsSync(path.join(dataDir, 'sessions-metadata.json')) ? readFile(dataDir) : null);
        return fs.promises.writeFile(target, payload, encoding);
      },
    };
    const store = createSessionMetadataStore({ dataDir, fsPromises });

    await store.setSessionMetadata('ses_1', { a: 1 });
    await store.setSessionMetadata('ses_2', { b: 2 });

    expect(seen).toEqual([null, JSON.stringify({ ses_1: { a: 1 } })]);
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: { a: 1 }, ses_2: { b: 2 } });
  });

  it('treats a malformed file as empty, keeps a backup, and still accepts writes', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'sessions-metadata.json'), '{ not json', 'utf8');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createSessionMetadataStore({ dataDir });
    await expect(store.getAll()).resolves.toEqual({});
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).resolves.toEqual({ a: 1 });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: { a: 1 } });
    expect(fs.readdirSync(dataDir).some((name) => name.includes('sessions-metadata.json.'))).toBe(true);
  });

  it('drops entries that are not metadata objects', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(
      path.join(dataDir, 'sessions-metadata.json'),
      JSON.stringify({ ses_ok: { a: 1 }, ses_list: ['a'], ses_text: 'nope', ses_null: null }),
      'utf8',
    );
    const store = createSessionMetadataStore({ dataDir });
    await expect(store.getAll()).resolves.toEqual({ ses_ok: { a: 1 } });
  });

  it('refuses to write when the file could not be read, so unknown state is never overwritten', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'sessions-metadata.json'), '{}', 'utf8');
    const unreadable = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const fsPromises = {
      ...fs.promises,
      readFile: async () => { throw unreadable; },
      writeFile: async () => { throw new Error('must not write'); },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createSessionMetadataStore({ dataDir, fsPromises });
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).rejects.toThrow(/could not be read/);
    expect(readFile(dataDir)).toBe('{}');
  });

  it('rolls memory back and reports failure when persisting fails', async () => {
    const dataDir = makeDataDir();
    const fsPromises = { ...fs.promises, writeFile: async () => { throw new Error('disk full'); } };

    const store = createSessionMetadataStore({ dataDir, fsPromises });
    await expect(store.setSessionMetadata('ses_1', { a: 1 })).rejects.toThrow('disk full');
    await expect(store.get('ses_1')).resolves.toEqual({});
  });

  it('keeps a later successful write when an earlier one fails and rolls back', async () => {
    const dataDir = makeDataDir();
    let failNext = true;
    let releaseFailure;
    const failureReleased = new Promise((resolve) => { releaseFailure = resolve; });
    const fsPromises = {
      ...fs.promises,
      writeFile: async (...args) => {
        if (failNext) {
          failNext = false;
          await failureReleased;
          throw new Error('disk full');
        }
        return fs.promises.writeFile(...args);
      },
    };
    const store = createSessionMetadataStore({ dataDir, fsPromises });

    const failing = store.setSessionMetadata('ses_1', { a: 1 });
    const succeeding = store.setSessionMetadata('ses_1', { b: 1 });
    releaseFailure();

    await expect(failing).rejects.toThrow('disk full');
    await expect(succeeding).resolves.toEqual({ b: 1 });
    // The failed write's rollback must not undo what the later write committed.
    await expect(store.get('ses_1')).resolves.toEqual({ b: 1 });
    expect(JSON.parse(readFile(dataDir))).toEqual({ ses_1: { b: 1 } });
  });

  describe('seeding from the OpenCode record', () => {
    it('folds what OpenCode holds into the first write instead of replacing it', async () => {
      const dataDir = makeDataDir();
      const readUpstreamMetadata = vi.fn(async () => ({ openchamber: { kind: 'review', assist: { recap: 'v1' } } }));
      const store = createSessionMetadataStore({ dataDir, readUpstreamMetadata });

      const merged = await store.setSessionMetadata('ses_v1', { openchamber: { goal: { status: 'active' } } }, { directory: '/repo' });
      expect(merged).toEqual({ openchamber: { kind: 'review', assist: { recap: 'v1' }, goal: { status: 'active' } } });
      expect(readUpstreamMetadata).toHaveBeenCalledWith('ses_v1', { directory: '/repo' });
      expect(JSON.parse(readFile(dataDir))).toEqual({ ses_v1: merged });

      // Once seeded, OpenCode is not consulted again for that session.
      await store.setSessionMetadata('ses_v1', { openchamber: { goal: { status: 'paused' } } });
      await store.get('ses_v1');
      expect(readUpstreamMetadata).toHaveBeenCalledTimes(1);
    });

    it('seeds a read too, so readers see what OpenCode holds and the seed persists', async () => {
      const dataDir = makeDataDir();
      const readUpstreamMetadata = vi.fn(async () => ({ openchamber: { pins: { notes: ['n1'] } } }));
      const store = createSessionMetadataStore({ dataDir, readUpstreamMetadata });

      await expect(store.get('ses_v1')).resolves.toEqual({ openchamber: { pins: { notes: ['n1'] } } });
      expect(JSON.parse(readFile(dataDir))).toEqual({ ses_v1: { openchamber: { pins: { notes: ['n1'] } } } });
      await expect(store.get('ses_v1')).resolves.toEqual({ openchamber: { pins: { notes: ['n1'] } } });
      expect(readUpstreamMetadata).toHaveBeenCalledTimes(1);
    });

    it.each(['reviewSessionID', 'btwSessionID'])('keeps a cleared %s absent after reads, restart and another write', async (linkKey) => {
      const dataDir = makeDataDir();
      const readUpstreamMetadata = vi.fn(async () => ({ openchamber: { [linkKey]: 'ses_old' } }));
      const store = createSessionMetadataStore({ dataDir, readUpstreamMetadata });
      await store.get('ses_parent');

      await expect(store.setSessionMetadata('ses_parent', { openchamber: null })).resolves.toEqual({});
      await expect(store.get('ses_parent')).resolves.toEqual({});
      expect(JSON.parse(readFile(dataDir))).toEqual({ ses_parent: {} });

      const reopened = createSessionMetadataStore({ dataDir, readUpstreamMetadata });
      await expect(reopened.get('ses_parent')).resolves.toEqual({});
      await expect(reopened.setSessionMetadata('ses_parent', { openchamber: { goal: { id: 'g1' } } }))
        .resolves.toEqual({ openchamber: { goal: { id: 'g1' } } });
      expect(readUpstreamMetadata).toHaveBeenCalledTimes(1);
    });

    it('stops the write when OpenCode could not be asked, and retries on the next write', async () => {
      const dataDir = makeDataDir();
      const readUpstreamMetadata = vi.fn()
        .mockRejectedValueOnce(new Error('opencode down'))
        .mockResolvedValueOnce({ openchamber: { kind: 'review' } });
      const store = createSessionMetadataStore({ dataDir, readUpstreamMetadata });

      await expect(store.setSessionMetadata('ses_v1', { openchamber: { goal: {} } })).rejects.toThrow('opencode down');
      await expect(store.getAll()).resolves.toEqual({});
      expect(fs.existsSync(path.join(dataDir, 'sessions-metadata.json'))).toBe(false);

      await expect(store.setSessionMetadata('ses_v1', { openchamber: { goal: {} } }))
        .resolves.toEqual({ openchamber: { kind: 'review', goal: {} } });
    });

    it('surfaces a failed read instead of answering empty', async () => {
      const store = createSessionMetadataStore({
        dataDir: makeDataDir(),
        readUpstreamMetadata: async () => { throw new Error('opencode down'); },
      });
      await expect(store.get('ses_v1')).rejects.toThrow('opencode down');
    });

    it('treats a session OpenCode does not know, or holds nothing for, as definitively empty', async () => {
      const readUpstreamMetadata = vi.fn(async () => null);
      const store = createSessionMetadataStore({ dataDir: makeDataDir(), readUpstreamMetadata });

      await expect(store.get('ses_new')).resolves.toEqual({});
      await expect(store.setSessionMetadata('ses_new', { a: 1 })).resolves.toEqual({ a: 1 });
      await store.setSessionMetadata('ses_new', { b: 1 });
      expect(readUpstreamMetadata).toHaveBeenCalledTimes(1);
    });

    it('does not ask OpenCode about a session already on disk', async () => {
      const dataDir = makeDataDir();
      fs.writeFileSync(path.join(dataDir, 'sessions-metadata.json'), JSON.stringify({ ses_1: { a: 1 } }), 'utf8');
      const readUpstreamMetadata = vi.fn(async () => ({ stale: true }));
      const store = createSessionMetadataStore({ dataDir, readUpstreamMetadata });

      await expect(store.get('ses_1')).resolves.toEqual({ a: 1 });
      await expect(store.setSessionMetadata('ses_1', { b: 1 })).resolves.toEqual({ a: 1, b: 1 });
      expect(readUpstreamMetadata).not.toHaveBeenCalled();
    });
  });

  it('forgets a session on request', async () => {
    const dataDir = makeDataDir();
    const store = createSessionMetadataStore({ dataDir });
    await store.setSessionMetadata('ses_1', { a: 1 });

    await expect(store.removeSession('ses_1')).resolves.toBe(true);
    await expect(store.removeSession('ses_1')).resolves.toBe(false);
    expect(JSON.parse(readFile(dataDir))).toEqual({});
  });
});
