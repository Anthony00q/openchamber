import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { requireOpenCodeV2 } from './compatibility.js';

const releaseSchema = z.object({ version: z.string().regex(/^2\.\d+\.\d+$/) });
export const supportsOpenCodeV2Install = () =>
  (process.platform === 'darwin' || process.platform === 'linux') && (process.arch === 'x64' || process.arch === 'arm64');

const runInstaller = (script, version, env) => new Promise((resolve, reject) => {
  const child = spawn('/bin/bash', [script, '--version', version, '--no-modify-path'], {
    env, cwd: os.tmpdir(), detached: true, stdio: 'ignore',
  });
  const terminate = () => {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
  };
  const timer = setTimeout(terminate, 5 * 60_000);
  child.once('error', () => {
    clearTimeout(timer);
    reject(new Error('Could not start the OpenCode installer.'));
  });
  child.once('close', (code) => {
    clearTimeout(timer);
    terminate();
    // Installer output may contain environment or registry secrets.
    if (code === 0) resolve();
    else reject(new Error('OpenCode installation failed. Try the official installation guide.'));
  });
});

// Only host-owned callers supply these options. No request body controls a
// command, URL, version, destination, or environment.
export const installOpenCodeV2 = async ({
  homeDirectory = os.homedir(),
  env = process.env,
  fetchImpl = fetch,
} = {}) => {
  if (!supportsOpenCodeV2Install()) throw new Error('Automatic OpenCode v2 installation is unavailable on this platform.');
  const directory = path.join(homeDirectory, '.opencode', 'bin');
  await fs.mkdir(directory, { recursive: true });
  const lock = path.join(directory, '.openchamber-install');
  // Also serializes separate OpenChamber/VS Code processes sharing this home.
  await fs.mkdir(lock).catch(() => { throw new Error('Another OpenCode installation is already in progress.'); });
  const snapshots = [];
  let started = false;
  let cleanup = true;
  try {
    const releaseResponse = await fetchImpl('https://registry.npmjs.org/@opencode%2Fcli/latest', { signal: AbortSignal.timeout(15_000) });
    if (!releaseResponse.ok) throw new Error('Could not resolve the OpenCode v2 release.');
    const { version } = releaseSchema.parse(await releaseResponse.json());
    const response = await fetchImpl('https://opencode.ai/v2/install', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Could not download the OpenCode installer.');
    const script = path.join(lock, 'install.sh');
    await fs.writeFile(script, await response.text(), { mode: 0o600 });
    for (const name of ['opencode', 'opencode2']) {
      const target = path.join(directory, name);
      const backup = path.join(lock, name);
      const exists = await fs.lstat(target).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      if (exists) await fs.cp(target, backup, { dereference: false, verbatimSymlinks: true });
      snapshots.push({ target, backup, exists });
    }
    started = true;
    await runInstaller(script, version, env);
    const binary = path.join(directory, 'opencode');
    const installedVersion = await requireOpenCodeV2({ binary, args: [] }, { env });
    if (installedVersion !== version) throw new Error('The installed OpenCode version does not match the requested release.');
    return binary;
  } catch (error) {
    if (started) {
      try {
        for (const { target, backup, exists } of snapshots) {
          await fs.rm(target, { force: true });
          if (exists) await fs.rename(backup, target);
        }
      } catch {
        // Keep any remaining backups for manual recovery; never delete them
        // after a failed rollback or allow another installer to overwrite them.
        cleanup = false;
        throw new Error('Could not restore the previous OpenCode installation. The backup remains in .opencode/bin/.openchamber-install.');
      }
    }
    throw error;
  } finally {
    if (cleanup) await fs.rm(lock, { recursive: true, force: true });
  }
};
