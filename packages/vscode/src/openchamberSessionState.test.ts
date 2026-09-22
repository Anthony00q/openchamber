import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type JsonValue,
  createSessionStateStore,
  isSessionRecordPath,
  mergeMetadataPatch,
  overlaySessionResponseBody,
  type SessionStateFs,
} from './openchamberSessionState';

/** In-memory file system: the store must read before every write and rename atomically. */
const createMemoryFs = (initial: Record<string, string> = {}) => {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const fsPromises: SessionStateFs = {
    readFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        const error = new Error('missing') as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
    writeFile: async (filePath, data) => {
      files.set(filePath, data);
      writes.push(filePath);
    },
    rename: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error(`rename source missing: ${from}`);
      files.delete(from);
      files.set(to, content);
    },
    mkdir: async () => undefined,
  };
  return { fsPromises, files, writes };
};

describe('openchamber session state store', () => {
  it('archives and unarchives a batch and reads the flags back from disk', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });

    assert.deepEqual(await store.archive(['ses_a', 'ses_b', 'ses_a'], null), {
      archived: [{ id: 'ses_a', archivedAt: 1000 }, { id: 'ses_b', archivedAt: 1000 }],
      failedIds: [],
    });
    assert.deepEqual(await store.readArchived(), { ses_a: 1000, ses_b: 1000 });
    assert.equal(memory.files.has(store.archivePath), true);
    // Every write went through a temp file that was renamed into place.
    assert.equal(memory.writes.every((filePath) => filePath.endsWith('.tmp')), true);

    assert.deepEqual(await store.unarchive(['ses_a']), { restored: [{ id: 'ses_a', archivedAt: null }], failedIds: [] });
    // The unarchive stays on file: it overrides an archived stamp OpenCode may still carry.
    assert.deepEqual(await store.readArchived(), { ses_a: null, ses_b: 1000 });
  });

  it('keeps a change another process made between two of its own writes', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 1000 });
    await store.archive(['ses_a']);
    // The desktop app archives ses_c in the same file.
    memory.files.set(store.archivePath, JSON.stringify({ ses_a: 1000, ses_c: 2000 }));

    await store.archive(['ses_b']);

    assert.deepEqual(await store.readArchived(), { ses_a: 1000, ses_b: 1000, ses_c: 2000 });
  });

  it('reports every id as failed when the archive file cannot be read', async () => {
    const memory = createMemoryFs();
    memory.fsPromises.readFile = async () => { throw new Error('EACCES'); };
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises });

    assert.deepEqual(await store.archive(['ses_a']), { archived: [], failedIds: ['ses_a'] });
    assert.equal(await store.readArchived(), null);
    assert.deepEqual(memory.writes, []);
  });

  it('moves an unreadable file aside instead of overwriting it', async () => {
    const memory = createMemoryFs({ '/data/sessions-archive.json': '{not json' });
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises, now: () => 5 });

    assert.deepEqual(await store.readArchived(), {});
    assert.equal(memory.files.get('/data/sessions-archive.json.corrupt-5'), '{not json');
  });

  it('merges metadata patches per key and deletes on null', async () => {
    const memory = createMemoryFs();
    const store = createSessionStateStore({ dataDir: '/data', fsPromises: memory.fsPromises });

    await store.setMetadata('ses_a', { openchamber: { goal: { objective: 'ship' }, assist: { recap: 'r' } } });
    const merged = await store.setMetadata('ses_a', { openchamber: { goal: null, pinned: true } });

    assert.deepEqual(merged, { openchamber: { assist: { recap: 'r' }, pinned: true } });
    assert.deepEqual(await store.getMetadata('ses_a'), merged);
    assert.deepEqual(await store.getMetadata('ses_missing'), {});

    // Clearing the last key drops the session from the file altogether.
    await store.setMetadata('ses_a', { openchamber: null });
    assert.deepEqual(await store.readMetadata(), {});
  });
});

describe('mergeMetadataPatch', () => {
  it('replaces non-object values and recurses into objects', () => {
    assert.deepEqual(mergeMetadataPatch({ a: { b: 1, c: 2 }, d: 'x' }, { a: { b: null, e: 3 }, d: ['y'] }), {
      a: { c: 2, e: 3 },
      d: ['y'],
    });
  });
});

describe('overlaySessionResponseBody', () => {
  const archived = { ses_a: 1234 };
  const stored = { ses_a: { openchamber: { pinned: true } } };

  it('folds archive time and stored metadata onto list and detail envelopes', () => {
    const list: JsonValue = {
      data: [
        { id: 'ses_a', time: { created: 1 }, metadata: { seed: 1 } },
        { id: 'ses_b', time: { created: 2, archived: 99 } },
        { id: 'ses_c', time: { created: 3, archived: 77 } },
      ],
      cursor: {},
    };
    assert.deepEqual(overlaySessionResponseBody(list, { ...archived, ses_b: null }, stored), {
      data: [
        { id: 'ses_a', time: { created: 1, archived: 1234 }, metadata: { seed: 1, openchamber: { pinned: true } } },
        // An explicit unarchive drops the stamp OpenCode still carries.
        { id: 'ses_b', time: { created: 2 } },
        // A session the file does not mention keeps what OpenCode says (migrated v1 archive).
        { id: 'ses_c', time: { created: 3, archived: 77 } },
      ],
      cursor: {},
    });
    assert.deepEqual(overlaySessionResponseBody({ data: { id: 'ses_a', time: {} } }, archived, null), {
      data: { id: 'ses_a', time: { archived: 1234 } },
    });
  });

  it('leaves the body alone when nothing is known', () => {
    const body = { data: [{ id: 'ses_a', time: { archived: 7 } }] };
    assert.equal(overlaySessionResponseBody(body, null, null), body);
    assert.equal(overlaySessionResponseBody('not json', archived, stored), 'not json');
  });

  it('matches only the list and single-record session paths', () => {
    assert.equal(isSessionRecordPath('/api/session'), true);
    assert.equal(isSessionRecordPath('/api/session/ses_a'), true);
    assert.equal(isSessionRecordPath('/api/session/ses_a/message'), false);
  });
});
