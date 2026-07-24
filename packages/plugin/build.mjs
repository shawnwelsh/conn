import { build } from "esbuild";

/**
 * Bundling the Stream Deck plugin. A build script rather than a CLI one-liner
 * because two of these settings are load-bearing and each one, when wrong,
 * fails as a bare "Process stopped (unexpected): code=1" in Stream Deck's log
 * with no other clue.
 *
 *  - format esm: the package is `"type": "module"` and @elgato/streamdeck is
 *    ESM-only, so CJS output in a .js file gets parsed as ESM and dies.
 *  - tsconfig: carries experimentalDecorators, without which esbuild emits the
 *    SDK's `@action(...)` decorator verbatim and the bundle won't parse.
 *  - banner: `ws` is CommonJS and reaches for require() at load; an ESM bundle
 *    has no require, so one is made from import.meta.url.
 */
await build({
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24", // the runtime the manifest asks Stream Deck for
  tsconfig: "tsconfig.json",
  outfile: "com.shawnwelsh.conn.sdPlugin/bin/plugin.js",
  banner: {
    js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
  },
});
