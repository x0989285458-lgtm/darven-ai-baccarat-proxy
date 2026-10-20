# Frontend canonical six-raw regression

`npm test` (or `node node_modules/vitest/vitest.mjs run`) runs every current frontend test, including the edge worker tests and cross-package live-client contracts. `vitest.config.ts` disables `.env` loading with `envDir: false`. Keep `proxy/node_modules` available for the real proxy imports, including `ws`; do not remove that dependency mount after running backend tests.

Current member raw identities, in order: `BAV01`, `BAV02`, `BAV03`, `BAV03A`, `BAV05`, `BAV06`. Display identities are `B01-L` through `B06-L`. Fixtures and general UI assertions use that contract; existing admin, login, licensing, prediction, history, polling, expiry, road and CSS functionality remains in the canonical suite. The existing ten-card admin analysis layout is unchanged and remains tested; it is not the member live-table allowlist.

## Immutable historical release lane

Only `src/App-release.test.tsx` is excluded from current discovery. Its bytes are unchanged. Its seven assertions are retained in `src/App-six-raw-release-contract.test.tsx`, changing only BAG fixture identities to BAV and the suite/version-description labels. No functional assertion was dropped.

Historical tag: `v105-origin-recovery.20261019.1`

Resolved immutable commit: `b842f12ff5afbc017ff44e400f4abc00cf8820b0`

Run the original `App-release.test.tsx` against that commit's source, not the current six-raw checkout. Materialize only `frontend/src`, `frontend/public`, `frontend/package.json`, `frontend/vitest.config.ts`, and `shared` from `git archive <commit> <paths>` into a disposable directory; mount existing frontend dependencies. Supply a separate Vitest config with that historical frontend root, `envDir: false`, React plugin, `test.include: ['src/App-release.test.tsx']`, jsdom, globals, CSS and `./src/test/setup.ts`. Never transform the frozen test or product source. The executed historical config and output are recorded in the Hermes cutover cache receipt.

## Production build

Typecheck with `node node_modules/typescript/bin/tsc -b`. Build with Vite's JS API, preserving `vite.config.ts` but overriding `envDir: false` and `mode: 'production'`. Explicitly supply only the public build settings:

- `VITE_DRAVEN_API_MODE=cloud`
- `VITE_DRAVEN_CLOUD_API_URL=https://darven-ai-baccarat.pages.dev`

Do not load repository `.env` files. Hash all files in `dist`, and verify that `dist/_worker.js` equals `public/_worker.js`. Offline tests/build are not deployment, DB, authenticated browser or production E2E evidence.
