import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Build script is JavaScript and deliberately has no runtime dependencies.
import { packageInventory, RUNTIME_FILES, NATIVE_HELPERS } from '../../scripts/package-mac.mjs';

// @ts-expect-error Dependency-free runtime provisioning module.
import { PORTABLE_CODE_BASE, PORTABLE_BASE_DOCKERFILE, verifyPortableBase } from '../../packages/code-runtime/portable-base.mjs';

test('local package uses an explicit runtime allowlist, verifies helpers and excludes unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-package-test-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.7.0' }));
    for (const path of [...RUNTIME_FILES, 'dist/renderer/index.html', 'dist/renderer/assets/app.js']) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), 'fixture');
      if (NATIVE_HELPERS.includes(path)) await chmod(join(root, path), 0o700);
    }
    await writeFile(join(root, '.env'), 'secret fixture must be omitted');
    await mkdir(join(root, 'node_modules/private-package'), { recursive: true });
    await writeFile(join(root, 'node_modules/private-package/token.json'), 'fixture');
    const inventory = await packageInventory(root, { checkArchitecture: false });
    assert.equal(inventory.entries.length, RUNTIME_FILES.length + 2);
    assert.ok(inventory.entries.every((entry: { path: string }) => !entry.path.includes('node_modules') && entry.path !== '.env'));
    const helper = join(root, NATIVE_HELPERS[0]);
    await chmod(helper, 0o600);
    await assert.rejects(packageInventory(root, { checkArchitecture: false }), /EACCES/);
    await chmod(helper, 0o700);
    await writeFile(join(root, 'dist/renderer/credentials.json'), 'fixture');
    await assert.rejects(packageInventory(root, { checkArchitecture: false }), /Unexpected renderer build asset/);
    await rm(join(root, 'dist/renderer/credentials.json'));
    await rm(helper); await symlink(join(root, '.env'), helper);
    await assert.rejects(packageInventory(root, { checkArchitecture: false }), /bounded regular/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('portable code base provenance binds ARM64, official digest and exact recipe', () => {
  const valid={Id:`sha256:${'a'.repeat(64)}`,Architecture:'arm64',Config:{Labels:{
    'io.agent-workspaces.base.recipe':createHash('sha256').update(PORTABLE_BASE_DOCKERFILE).digest('hex'),
    'io.agent-workspaces.base.official':PORTABLE_CODE_BASE.image,
  }}};
  assert.equal(verifyPortableBase(valid),valid.Id);
  assert.match(PORTABLE_CODE_BASE.image,/@sha256:[a-f0-9]{64}$/);
  assert.throws(()=>verifyPortableBase({...valid,Architecture:'amd64'}),/provenance/);
  assert.throws(()=>verifyPortableBase({...valid,Config:{...valid.Config,Volumes:{'/workspace':{}}}}),/provenance/);
  assert.throws(()=>verifyPortableBase({...valid,Config:{Labels:{...valid.Config.Labels,'io.agent-workspaces.base.recipe':'wrong'}}}),/provenance/);
  assert.ok(RUNTIME_FILES.includes('packages/code-runtime/portable-base.mjs'));
  assert.ok(RUNTIME_FILES.includes('containers/code/documents-recipe.json'));
  assert.ok(RUNTIME_FILES.includes('workers/code/supervisor.py'));
});
