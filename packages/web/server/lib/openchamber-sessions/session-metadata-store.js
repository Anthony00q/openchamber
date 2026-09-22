/**
 * OpenChamber-owned session metadata.
 *
 * OpenCode 2.x accepts `metadata` only when a session is created; the v1
 * `PATCH /session/{id}` route is gone and nothing replaces it. Four OpenChamber
 * features kept their per-session state there — goal mode, session assist,
 * obligatory context re-injection, and pinned notes/plans — so the state lives
 * here now: one JSON file per data dir, `{ [sessionID]: metadata }`, folded back
 * onto the sessions the proxy serves so clients keep reading `session.metadata`
 * where they always did.
 *
 * Writes are a JSON Merge Patch (RFC 7386): nested objects merge key by key and
 * a `null` deletes. That is what the old PATCH did, and it is what keeps two
 * features writing into the same `openchamber` namespace from erasing each
 * other — goal mode saving progress must not drop an assist recap.
 *
 * A session OpenCode migrated from v1 still carries the metadata v1 wrote onto
 * its record, and a session created through OpenChamber carries what was set
 * at create time. The proxy uses stored metadata as the full authoritative
 * record, so the store must preserve the upstream fields before applying a
 * feature's first patch. It seeds itself from the OpenCode record on first
 * access, inside the same transaction as the read or write that needed it. Every
 * reader and writer goes through this store, so nobody can skip the seed.
 * An empty object remains a stored record: it means metadata was cleared and
 * must survive reads and restarts without importing the old fields again.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

import { createOpenCodeClient as createOpenCodeClientDefault } from './opencode-client.js';

const METADATA_FILE_NAME = 'sessions-metadata.json';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * RFC 7386 merge. Returns a new object; `null` in the patch removes the key,
 * and a non-object patch value replaces whatever was there.
 */
export const mergeMetadataPatch = (current, patch) => {
  const base = isPlainObject(current) ? { ...current } : {};
  if (!isPlainObject(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    base[key] = isPlainObject(value) ? mergeMetadataPatch(base[key], value) : value;
  }
  return base;
};

const isSessionNotFound = (error) => error?._tag === 'SessionNotFoundError';

/**
 * Reads the metadata OpenCode holds for a session: what v1 wrote onto a
 * migrated record, or what was passed at create time. Resolves `null` when
 * OpenCode does not know the session, which is a definitive "nothing there".
 * Any other failure throws, because "could not ask" must not become "empty".
 */
export const createUpstreamSessionMetadataReader = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  createOpenCodeClient = createOpenCodeClientDefault,
}) => async (sessionID, { directory = '' } = {}) => {
  const client = createOpenCodeClient({
    baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
    headers: getOpenCodeAuthHeaders(),
    directory,
  });
  let session;
  try {
    session = await client.session.get({ sessionID });
  } catch (error) {
    if (isSessionNotFound(error)) return null;
    throw error;
  }
  // The 2.x client unwraps the `{ data }` envelope: this is the record itself.
  return isPlainObject(session?.metadata) ? session.metadata : null;
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {(sessionID: string, scope: { directory: string }) => Promise<object | null>} [options.readUpstreamMetadata]
 *   Seeds a session the store has never held from OpenCode's record. Absent
 *   means there is nothing to seed from (module tests, or a runtime without an
 *   OpenCode client).
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 */
export const createSessionMetadataStore = ({
  dataDir,
  readUpstreamMetadata = null,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}) => {
  const filePath = path.join(dataDir, METADATA_FILE_NAME);

  /** sessionID → metadata object. Authoritative once `loaded` is true. */
  const entries = new Map();
  /**
   * Sessions whose OpenCode record has been consulted with a definitive
   * answer. A session in `entries` counts as seeded too; this set only records
   * the ones where OpenCode had nothing, so they are not asked again.
   */
  const seeded = new Set();
  let loaded = false;
  let loadPromise = null;
  /**
   * Writes stay disabled until one load has told us what is already on disk.
   * A failed read is not evidence that nothing is stored, and writing over a
   * file we could not read would drop exactly the state we are protecting.
   */
  let writable = false;
  /**
   * One transaction at a time: seed, mutate memory, persist, roll back on
   * failure. Serializing only the file write is not enough — a rollback that
   * runs after a later transaction has already committed would erase that
   * transaction's memory while its bytes stay on disk, and the next write
   * would then erase the bytes too.
   */
  let transactionChain = Promise.resolve();
  const runExclusive = (work) => {
    const next = transactionChain.then(work, work);
    transactionChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const snapshot = () => Object.fromEntries(entries);

  const parseStored = (raw) => {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error('session metadata file is not a JSON object');
    }
    const result = new Map();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      // A non-object entry is not metadata; dropping it is better than handing
      // a consumer something it will read fields off.
      if (id && isPlainObject(value)) result.set(id, value);
    }
    return result;
  };

  const readFile = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      // No file yet is the normal first run: nothing is stored, and writing is
      // safe because there is no state to lose.
      if (error?.code === 'ENOENT') return { ok: true, stored: new Map() };
      console.warn('[openchamber-sessions] could not read the session metadata file:', error?.message ?? error);
      return { ok: false, stored: null };
    }

    try {
      return { ok: true, stored: parseStored(raw) };
    } catch (error) {
      // Malformed bytes are kept for the user instead of being overwritten on
      // the next write, and whatever this process already knows stays in memory
      // rather than collapsing to "no metadata".
      const backup = `${filePath}.corrupt-${now()}`;
      await fsPromises.rename(filePath, backup).catch(() => undefined);
      console.warn(
        `[openchamber-sessions] session metadata file was unreadable and was moved to ${backup}: ${error?.message ?? error}`,
      );
      return { ok: true, stored: new Map() };
    }
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile().then((result) => {
        if (result.ok) {
          // Merge rather than replace: a write that happened while the first
          // load was still running must survive it.
          for (const [id, metadata] of result.stored) {
            if (!entries.has(id)) entries.set(id, metadata);
          }
          loaded = true;
          writable = true;
        } else {
          // Let a later call retry; until one succeeds the store answers reads
          // from memory and refuses writes.
          loadPromise = null;
        }
        return { ok: result.ok, entries: snapshot() };
      });
    }
    return loadPromise;
  };

  /** Only ever called inside `runExclusive`, so two writes cannot interleave their renames. */
  const persist = async () => {
    const payload = JSON.stringify(snapshot());
    await fsPromises.mkdir(dataDir, { recursive: true });
    // Temp file in the same directory so the rename is atomic on one device:
    // a reader sees either the previous file or the complete new one.
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, payload, 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  };

  const isSeeded = (id) => entries.has(id) || seeded.has(id);

  /**
   * Returns what OpenCode holds for a session the store has never seen, or
   * `undefined` when there is nothing to fold in. Throws when OpenCode could
   * not be asked: the caller must not proceed as if the answer were "nothing",
   * because the first write would then overwrite the record's namespace.
   * Only ever called inside `runExclusive`.
   */
  const readSeed = async (id, directory) => {
    if (isSeeded(id) || !readUpstreamMetadata) return undefined;
    const upstream = await readUpstreamMetadata(id, { directory });
    if (isPlainObject(upstream) && Object.keys(upstream).length > 0) return upstream;
    seeded.add(id);
    return undefined;
  };

  const requireWritable = async () => {
    const loadResult = await load();
    if (!loadResult.ok || !writable) {
      throw new Error('session metadata is unavailable: its file could not be read');
    }
  };

  /**
   * Replaces one session's entry, persists, and restores the entry when the
   * write fails. Only ever called inside `runExclusive`.
   */
  const commit = async (id, next) => {
    const had = entries.has(id);
    const previous = entries.get(id);
    if (next === undefined) entries.delete(id);
    else entries.set(id, next);
    try {
      await persist();
    } catch (error) {
      if (had) entries.set(id, previous);
      else entries.delete(id);
      throw error;
    }
  };

  /**
   * The session's full metadata. A session the store has never held is seeded
   * from OpenCode first, and that seed is persisted so the proxy overlay and
   * later writes see the same record. Throws when the seed could not be read.
   */
  const get = async (sessionID, { directory = '' } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return {};
    await load();
    if (isSeeded(id)) return entries.get(id) ?? {};
    return runExclusive(async () => {
      // Re-checked under the lock: a transaction ahead of us may have seeded it.
      if (isSeeded(id)) return entries.get(id) ?? {};
      const seed = await readSeed(id, directory);
      if (seed === undefined) return {};
      await requireWritable();
      await commit(id, seed);
      return seed;
    });
  };

  /**
   * Applies a merge patch and returns the session's full metadata afterwards.
   * A failed write rolls the memory back and throws, so a caller never believes
   * it saved something it did not.
   */
  const setSessionMetadata = async (sessionID, patch, { directory = '' } = {}) => {
    const id = asNonEmptyString(sessionID);
    if (!id) throw new Error('a session id is required to store session metadata');
    if (!isPlainObject(patch)) throw new Error('a session metadata patch must be an object');

    return runExclusive(async () => {
      await requireWritable();
      // Seeding is part of this write: a failed upstream read stops the write
      // instead of letting the patch replace what OpenCode still holds.
      const seed = await readSeed(id, directory);
      const base = seed ?? entries.get(id);
      const merged = mergeMetadataPatch(base, patch);
      await commit(id, merged);
      return merged;
    });
  };

  const removeSession = async (sessionID) => {
    const id = asNonEmptyString(sessionID);
    if (!id) return false;
    return runExclusive(async () => {
      await load();
      if (!writable || !entries.has(id)) return false;
      try {
        await commit(id, undefined);
      } catch (error) {
        console.warn('[openchamber-sessions] failed to drop session metadata:', error?.message ?? error);
        return false;
      }
      return true;
    });
  };

  const getAll = async () => {
    await load();
    return snapshot();
  };

  return {
    load,
    get,
    getAll,
    list: getAll,
    isLoaded: () => loaded,
    setSessionMetadata,
    removeSession,
    filePath,
  };
};
