# Evals

These suites target [`agent-evals`](https://github.com/marianoberton/agent-evals),
the sibling project: a deterministic harness whose judge (a Jev noul, thresholded)
is calibrated enough to gate a deploy on.

**That library is not published yet.** So this directory is written and ready but
not wired into CI, and `evals/` is excluded from `tsconfig.json` — the import
would not resolve and would turn the whole typecheck red for a dependency that
does not exist.

When `agent-evals` ships:

```bash
npm i -D agent-evals
npx agent-evals run evals/*.suite.ts --threshold 0.9 --fail-under
```

and add that line to `.github/workflows/ci.yml`, after `npm test`.

The suite runs against `runTurn()` directly, which is why the determinism test in
`tests/core/turn.test.ts` matters: a suite whose cassettes replay must produce
the same report twice, and it only can if the turn has no ambient I/O.
