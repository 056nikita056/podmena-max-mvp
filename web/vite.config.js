import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({ root: here, build: { outDir: resolve(here, '../dist'), emptyOutDir: true }, server: { proxy: { '/api': 'http://localhost:3000' } } });
