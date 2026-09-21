import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  dts: true,
  // clean:false on purpose. The dev loop relies on Cordis HMR, and
  // cordis-plugin-hmr reacts only to `change` events (`if (kind !== 'change')
  // return`). A cleaning build deletes dist first, so the watcher sees
  // unlink+add and never reloads the plugin. Overwriting in place emits
  // `change`, which is what makes `pnpm run build` hot-reload the running
  // harness. Remove stale output manually if the entry set ever changes.
  clean: false,
  platform: 'node',
})
