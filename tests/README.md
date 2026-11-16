# Lean regression suite

Run the complete suite; there is no separate optional or legacy suite:

```sh
npm run typecheck
npm test
npm run test:electron
```

`npm test` runs vitest on system Node. `npm run test:electron` runs the same files on the Node
runtime embedded in Electron, where the app, the ML worker, and the packaged CLI execute.

Keep tests for observable contracts: file safety and recovery, feedback labels,
CLI and service behavior, platform integration, startup/shutdown, and concurrency or
cache regressions that can cause repeated actions to stall or use stale data.

Prefer one representative workflow over repeated tests of its internal helpers.
Use temporary libraries (`tests/helpers/sandbox.ts`) and mock external services, not the
behavior under test. Performance tests should check bounded work, lock contention or request
coalescing rather than wall-clock thresholds.

`tests/fixtures/` holds parity fixtures generated from the original Python implementation of
the preference model and suggestion statistics. They pin numerical behavior: a change that
moves scores is a behavior change, not a refactor.

Do not lock down CSS declarations, DOM structure, exact UI copy, icon pixels,
or incidental call counts. Check visual changes with a renderer screenshot.
Add a regression when it protects a concrete user-visible failure, not merely
because a new helper was introduced.
