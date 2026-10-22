# Owlery runner picker

Routes a workflow's jobs to Owlery when it is healthy and has what they ask
for, and to your own fallback runners when it is not: Owlery down or
unreachable, or a label no Owlery machine offers at all. When machines offer
the label but none is ready (one restarting, say), the picker waits out the
repository's grace period first. A busy but healthy Owlery keeps the job;
this is a health check, not a scheduler. Design: `docs/runner-fallback.md`.

```yaml
jobs:
  pick:
    runs-on: ubuntu-latest          # your cheapest runner that isn't Owlery
    timeout-minutes: 35
    permissions:
      id-token: write
    outputs:
      runner: ${{ steps.p.outputs.runner }}
    steps:
      - id: p
        uses: owlery-sh/runner@v1
        with:
          want: owlery-macos
          fallback: macos-15
  build:
    needs: pick
    runs-on: ${{ needs.pick.outputs.runner }}
```

Several routes at once, one output per key:

```yaml
        with:
          routes: |
            linux: owlery-linux -> ubuntu-latest
            mac: owlery-macos -> macos-15
```

`server` defaults to `https://hooks.owlery.sh`; a self-hosted Owlery passes
its own public origin.

On Owlery's hosted service fallback is off until it is turned on for the
repository in the dashboard, and until then Owlery answers "Owlery" for
every route. A self-hosted Owlery has no dashboard to turn it on from, so the
picker being in the workflow is the opt-in there. Either way, when the picker
itself cannot get an answer — Owlery unreachable, an error, no OIDC token —
it chooses the fallback: that is the case it exists for.

Tests: `node --test actions/runner/index.test.js`.
