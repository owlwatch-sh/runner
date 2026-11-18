# Owlwatch runner picker

Routes a workflow's jobs to Owlwatch when it is healthy and has what they ask
for, and to your own fallback runners when it is not: Owlwatch down or
unreachable, or a label no Owlwatch machine offers at all. When machines offer
the label but none is ready (one restarting, say), the picker waits out the
repository's grace period first. A busy but healthy Owlwatch keeps the job;
this is a health check, not a scheduler. Design: `docs/runner-fallback.md`.

```yaml
jobs:
  pick:
    runs-on: ubuntu-latest          # your cheapest runner that isn't Owlwatch
    timeout-minutes: 35
    permissions:
      id-token: write
      issues: write                 # the fallback issue; see below
    outputs:
      runner: ${{ steps.p.outputs.runner }}
    steps:
      - id: p
        uses: owlwatch-sh/runner@v1
        with:
          want: owlwatch-macos
          fallback: macos-15
  build:
    needs: pick
    runs-on: ${{ needs.pick.outputs.runner }}
```

Several routes at once, one output per key:

```yaml
        with:
          routes: |
            linux: owlwatch-linux -> ubuntu-latest
            mac: owlwatch-macos -> macos-15
```

`server` defaults to `https://hooks.owlwatch.sh`; a self-hosted Owlwatch passes
its own public origin.

On Owlwatch's hosted service fallback is off until it is turned on for the
repository in the dashboard, and until then Owlwatch answers "Owlwatch" for
every route. A self-hosted Owlwatch has no dashboard to turn it on from, so the
picker being in the workflow is the opt-in there. Either way, when the picker
itself cannot get an answer — Owlwatch unreachable, an error, no OIDC token —
it chooses the fallback: that is the case it exists for.

## The fallback issue

Falling back should be rare, so the picker says so where you will see it: when
any route falls back it opens an issue titled **Runner fallback used**
(labelled `owlwatch-runner-fallback`) or, if one is already open, comments on
it — when, which workflow, run and picker job, which labels, and why (Owlwatch
unreachable, unhealthy past the grace period, not offering the label, or a run
Owlwatch failed and re-ran). When a later run has every route served by
Owlwatch, the picker closes the issue with a comment. So an open issue means
runs have fallen back since it was last cleared.

It is written with the workflow's own `GITHUB_TOKEN`, so it works when Owlwatch
is down, and needs **`issues: write` on the pick job** (above). Owlwatch's
runners App is not asked for anything new. Without the permission the picker
still picks; the job summary says the issue could not be written. Nothing about
the issue ever fails the picker or changes its answer. Turn it off with:

```yaml
        with:
          alert: false
```

Tests: `node --test actions/runner/index.test.js`.
