import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./finalize-latest-yml.mjs', import.meta.url));

const manifest = (platform, architecture, extension) => `version: 1.2.3
files:
  - url: OpenChamber-1.2.3-${platform}-${architecture}.${extension}
    sha512: ${Buffer.alloc(64, architecture === 'x64' ? 1 : 2).toString('base64')}
    size: 123
releaseDate: '2026-07-30T00:00:00.000Z'
`;

const writeManifest = (artifacts, target, filename, content) => {
  fs.mkdirSync(path.join(artifacts, `latest-yml-${target}`), { recursive: true });
  fs.writeFileSync(path.join(artifacts, `latest-yml-${target}`, filename), content);
};

const createFixture = ({ includeWindowsArm64 = true } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-latest-yml-'));
  const artifacts = path.join(root, 'artifacts');
  const output = path.join(root, 'output');
  writeManifest(artifacts, 'x86_64-pc-windows-msvc', 'latest.yml', manifest('win', 'x64', 'exe'));
  if (includeWindowsArm64) {
    writeManifest(artifacts, 'aarch64-pc-windows-msvc', 'latest.yml', manifest('win', 'arm64', 'exe'));
  }
  fs.mkdirSync(output);
  return { root, artifacts, output };
};

const environment = ({ artifacts, output }) => ({
  ...process.env,
  LATEST_YML_DIR: artifacts,
  RUNNER_TEMP: output,
  GH_REPO: 'Anthony00q/openchamber',
  OPENCHAMBER_VERSION: '1.2.3',
});

test('writes only separate x64 and ARM64 Windows update channels', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  execFileSync(process.execPath, [script], { env: environment(fixture) });

  const x64 = fs.readFileSync(path.join(fixture.output, 'latest.yml'), 'utf8');
  const arm64 = fs.readFileSync(path.join(fixture.output, 'latest-arm64.yml'), 'utf8');
  assert.deepEqual(fs.readdirSync(fixture.output).sort(), ['latest-arm64.yml', 'latest.yml']);
  assert.match(x64, /win-x64\.exe/);
  assert.doesNotMatch(x64, /win-arm64\.exe/);
  assert.match(arm64, /win-arm64\.exe/);
  assert.doesNotMatch(arm64, /win-x64\.exe/);
});

test('fails instead of publishing an incomplete Windows channel set', (context) => {
  const fixture = createFixture({ includeWindowsArm64: false });
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Both x64 and arm64 Windows update manifests are required/);
});

for (const [label, mutate, error] of [
  ['stale version', (text) => text.replace('version: 1.2.3', 'version: 1.2.2'), /manifest version/],
  ['wrong architecture', (text) => text.replace('win-arm64.exe', 'win-x64.exe'), /must list only/],
  ['empty file list', () => 'version: 1.2.3\nfiles: []\n', /must list only/],
  ['invalid size', (text) => text.replace('size: 123', 'size: -1'), /invalid installer size/],
  ['invalid checksum', (text) => text.replace(/sha512: .*/, 'sha512: bad'), /invalid SHA-512/],
  ['invalid date', (text) => text.replace('2026-07-30T00:00:00.000Z', 'invalid'), /invalid release date/],
]) {
  test(`rejects ${label} before writing either channel`, (context) => {
    const fixture = createFixture();
    context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    writeManifest(fixture.artifacts, 'aarch64-pc-windows-msvc', 'latest.yml', mutate(manifest('win', 'arm64', 'exe')));
    const result = spawnSync(process.execPath, [script], { env: environment(fixture), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.deepEqual(fs.readdirSync(fixture.output), []);
  });
}
