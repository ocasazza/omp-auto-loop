# Third-party notices for omp-auto-loop.

Provenance: this repository vendors the omp auto-loop extension from
`nixos-config` (`modules/home/omp/auto-loop`), where it was developed
in-tree beside the omp harness module.

Upstream lineage:

- PrimeIntellect-ai/prime-agent (Apache-2.0) — `core/autonomous.ts`,
  `goals.ts`, `cron-jobs.ts`: the internal autonomous runtime this
  extension ports (budgets, settle gates, goal tool, heartbeat).
- DraconDev/opencode-auto-continue (AGPL-3.0-only) — the original
  settle-gate / auto-continue design.
- oh-my-pi/omptype — runtime schema builder (`GoalParams`); omp's runtime
  also supplies `@oh-my-pi/pi-coding-agent` types at session time.
- Nixpkgs — build system and packages.

Full license texts are in `LICENSES/` (`Apache-2.0.txt`,
`AGPL-3.0-only.txt`).
