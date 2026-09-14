import { dirname, basename } from 'node:path';
import { lstat, realpath, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises';

export async function prepareWorkspace(job, extract) {
  const dir = job.workspace;
  const base = dirname(dir);
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(job.slug) || basename(dir) !== job.slug ||
      !dir.startsWith('/') || await realpath(base) !== base)
    throw new Error('Invalid workspace path');
  let exists = false;
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Unsafe workspace');
    exists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (exists) {
    if (!job.workspace_ready) {
      let owner;
      try { owner = await readFile(dir + '/.aiworker-owner', 'utf8'); } catch {}
      if (owner !== String(job.id)) throw new Error('Workspace already exists and is not owned by this workload');
    }
    return dir;
  }
  const stage = base + '/.aiworker-stage-' + job.id;
  await rm(stage, {recursive: true, force: true});
  await mkdir(stage, {mode: 0o770});
  try {
    await extract(stage);
    await writeFile(stage + '/.aiworker-owner', String(job.id), {flag: 'wx', mode: 0o660});
    // Reserve the destination atomically; never replace an existing directory.
    await mkdir(dir, {mode: 0o770});
    await rename(stage, dir);
  } catch (error) {
    await rm(stage, {recursive: true, force: true});
    throw error;
  }
  return dir;
}
