import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('dist/main', { recursive: true });
await copyFile('containers/browser/seccomp.json','dist/main/browser-seccomp.json');
await esbuild({
  entryPoints: ['apps/desktop/main/main.ts', 'apps/desktop/main/preload.ts', 'apps/desktop/main/report-format-worker.ts'],
  outdir: 'dist/main', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  external: ['electron', 'node:sqlite'], sourcemap: false,
});
await viteBuild({
  root: resolve('apps/desktop/renderer'), base: './',
  build: { outDir: resolve('dist/renderer'), emptyOutDir: true, sourcemap: false },
});

// Written only after both bundles succeed; this is a build receipt, not a runtime guarantee.
const {writeBuildProvenance} = await import('./build-provenance.mjs');
await writeBuildProvenance('dist/build-provenance.json');
