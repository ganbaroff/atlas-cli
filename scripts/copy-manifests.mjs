#!/usr/bin/env node
/** Copy hand manifests into dist/ for bundled CLI resolution. */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/hands/manifests');
const dest = join(root, 'dist/manifests');

if (!existsSync(src)) {
  console.error(`[copy-manifests] missing source: ${src}`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-manifests] ${src} -> ${dest}`);
