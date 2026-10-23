import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

test('Windows manifests and publication require successful Windows builds', () => {
  assert.equal(
    workflow.jobs['combine-electron-manifests'].if,
    "${{ !cancelled() && needs.create-release.result == 'success' && needs.build-desktop-electron-windows.result == 'success' }}",
  );
  assert.deepEqual(workflow.jobs['finalize-release'].needs, ['create-release', 'build-desktop-electron-windows', 'combine-electron-manifests']);
  assert.equal(workflow.jobs['finalize-release'].if, "${{ !cancelled() && !failure() }}");
  const windows = workflow.jobs['build-desktop-electron-windows'];
  assert.equal(windows['runs-on'], 'windows-2022');
  assert.deepEqual(windows.strategy.matrix.include.map((entry) => entry.arch), ['x64', 'arm64']);
  const validation = windows.steps.findIndex((step) => step.name === 'Validate Windows update manifest');
  const upload = windows.steps.findIndex((step) => step.name === 'Upload installer to release');
  assert.ok(validation >= 0 && validation < upload);
  assert.match(windows.steps[validation].run, /verify-update-manifest\.mjs/);
});

test('non-Windows publication jobs stay disabled in the fork', () => {
  for (const job of ['publish-npm', 'build-desktop-electron-macos', 'build-desktop-electron-linux', 'publish-electron-linux', 'mobile-release']) {
    assert.equal(workflow.jobs[job].if, false, job);
  }
  for (const [filename, job] of [
    ['vscode-extension.yml', 'publish'],
    ['build-macos-arm64-dmg.yml', 'build-macos-dmg-arm64-electron'],
    ['mobile-release.yml', 'resolve-version'],
    ['sdk-preview.yml', 'publish'],
  ]) {
    const document = yaml.parse(fs.readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8'));
    assert.equal(document.jobs[job].if, false, filename);
  }
});

test('dry runs skip every release mutation and never refresh the upstream website', () => {
  for (const job of Object.values(workflow.jobs)) {
    if (job.if === false) continue;
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('softprops/action-gh-release@') || step.name === 'Verify final Windows release asset inventory' || step.name === 'Send release to Discord') {
        assert.ok(step.if?.includes("github.event.inputs.dry_run != 'true'"), step.name);
      }
    }
  }
  const refresh = workflow.jobs['finalize-release'].steps.find((step) => step.name === 'Trigger openchamber-website site refresh (optional)');
  assert.equal(refresh.if, false);
  const preflight = workflow.jobs['create-release'].steps.findIndex((step) => step.name === 'Verify fork release source');
  const publish = workflow.jobs['create-release'].steps.findIndex((step) => step.id === 'create_release');
  assert.ok(preflight >= 0 && preflight < publish);
});

test('release preflight accepts this fork and rejects a mismatched version', () => {
  const preflight = workflow.jobs['create-release'].steps.find((step) => step.name === 'Verify fork release source');
  const source = preflight.run.split("<<'NODE'\n")[1].split('\nNODE')[0];
  const root = new URL('../', import.meta.url);
  const version = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
  const run = (releaseVersion) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    env: { ...process.env, VERSION: releaseVersion },
    encoding: 'utf8',
  });
  const accepted = run(version);
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = run('0.0.0-wrong-version');
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /must match the release version/);
});
