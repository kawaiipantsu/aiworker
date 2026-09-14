import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { prepareWorkspace } from '../worker/workspace.mjs';
const run = promisify(execFile);
const cleanup = new URL('../contrib/remove-workspace.py', import.meta.url).pathname;

test('custom FQDN workspace extracts, resumes, and deletes with ownership checks', async () => {
  const base = await mkdtemp(tmpdir() + '/aiworker-workspace-');
  const job = {id: 987654, slug: 'app.example.com', workspace: base + '/app.example.com', workspace_ready: 0};
  try {
    assert.equal(await prepareWorkspace(job, stage => writeFile(stage + '/seed.txt', 'scaffold')), job.workspace);
    assert.equal(await readFile(job.workspace + '/seed.txt', 'utf8'), 'scaffold');
    await prepareWorkspace(job, () => assert.fail('Must not extract again'));
    await run('python3', [cleanup, job.workspace, String(job.id + 1), '0']);
    assert.equal((await stat(job.workspace)).isDirectory(), true);
    await run('python3', [cleanup, job.workspace, String(job.id), '0']);
    await assert.rejects(stat(job.workspace), {code: 'ENOENT'});
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('collisions, failed extraction, and symlink parents never overwrite existing files', async () => {
  const base = await mkdtemp(tmpdir() + '/aiworker-collision-');
  const job = {id: 987655, slug: 'example.com', workspace: base + '/example.com', workspace_ready: 0};
  try {
    await mkdir(job.workspace);
    await writeFile(job.workspace + '/keep.txt', 'keep');
    await assert.rejects(prepareWorkspace(job, () => {}), /already exists/);
    await run('python3', [cleanup, job.workspace, String(job.id), '0']);
    assert.equal(await readFile(job.workspace + '/keep.txt', 'utf8'), 'keep');
    await symlink(base, base + '/link');
    await assert.rejects(prepareWorkspace({...job, workspace: base + '/link/example.com'}, () => {}), /Invalid workspace/);
    await assert.rejects(run('python3', [cleanup, base + '/link/example.com', String(job.id), '1']));
    const fresh = {...job, slug: 'fresh', workspace: base + '/fresh'};
    await assert.rejects(prepareWorkspace(fresh, () => {throw new Error('Bad ZIP');}), /Bad ZIP/);
    await assert.rejects(stat(fresh.workspace), {code: 'ENOENT'});
    await assert.rejects(prepareWorkspace(fresh, async () => {
      await mkdir(fresh.workspace);
      await writeFile(fresh.workspace + '/keep.txt', 'concurrent folder');
    }), {code: 'EEXIST'});
    assert.equal(await readFile(fresh.workspace + '/keep.txt', 'utf8'), 'concurrent folder');
  } finally { await rm(base, {recursive: true, force: true}); }
});
