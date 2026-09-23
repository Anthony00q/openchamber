import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installOpenCodeV2 } from './v2-install.js';
import { readOpenCodeCliVersion } from './compatibility.js';

let homeDirectory;
let binary;
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const cli = (version) => '#!/bin/sh\nprintf "%s\\n" "opencode v' + version + '"\n';
const run = (script, version = '2.0.14') => installOpenCodeV2({
  homeDirectory,
  fetchImpl: async (url) => url.includes('registry.npmjs.org')
    ? Response.json({ version })
    : new Response(script),
});

beforeEach(async () => {
  homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-install-test-'));
  binary = path.join(homeDirectory, '.opencode/bin/opencode');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.writeFile(binary, cli('1.18.30'), { mode: 0o755 });
});
afterEach(async () => { await fs.rm(homeDirectory, { recursive: true, force: true }); });

describe('OpenCode v2 installation', () => {
  it('passes the validated release and verifies the actual executable', async () => {
    const script = `#!/bin/bash
set -eu
test "$1" = "--version"
test "$2" = "2.0.14"
test "$3" = "--no-modify-path"
printf %s ${quote(cli('2.0.14'))} > ${quote(binary)}
chmod 755 ${quote(binary)}
`;
    expect(await run(script)).toBe(binary);
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('2.0.14');
    await expect(fs.stat(path.join(path.dirname(binary), '.openchamber-install'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the binary and shim when an installer exits zero but leaves v1', async () => {
    const shim = path.join(path.dirname(binary), 'opencode2');
    await fs.symlink('opencode', shim);
    const script = `printf %s broken > ${quote(shim)}\nexit 0\n`;
    await expect(run(script)).rejects.toThrow();
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
    expect(await fs.readlink(shim)).toBe('opencode');
  });

  it('restores v1 after a partial installer failure, and permits a retry', async () => {
    const script = `printf %s broken > ${quote(binary)}\nexit 1\n`;
    await expect(run(script)).rejects.toThrow('installation failed');
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
    await expect(run(script)).rejects.toThrow('installation failed');
  });

  it('rejects a non-v2 registry release before running the installer', async () => {
    await expect(run(`rm ${quote(binary)}`, '3.0.0')).rejects.toThrow();
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
  });

  it('does not overwrite an installation owned by another process', async () => {
    const lock = path.join(path.dirname(binary), '.openchamber-install');
    await fs.mkdir(lock);
    await expect(run('exit 0')).rejects.toThrow('already in progress');
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
    expect(await readOpenCodeCliVersion({ binary, args: [] })).toBe('1.18.30');
  });
});
