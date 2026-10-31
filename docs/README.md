# Documentation

This is the index for RenderFlow's engineering and production documentation.

## Start here

| Document                                | Read it for                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------- |
| [`README.md`](../README.md)             | Project overview, local setup, commands and deployment summary.             |
| [`PROJECT.md`](../PROJECT.md)           | The source of truth: architecture decision, credit rules, phases and tests. |
| [`PHASES.md`](../PHASES.md)             | Current phase status and the gaps behind the status labels.                 |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | Runtime components, data flow, credits, jobs, outbox and scaling.           |
| [`SECURITY.md`](../SECURITY.md)         | Threat model, controls, security checklist and known gaps.                  |
| [`DEPLOYMENT.md`](../DEPLOYMENT.md)     | Build, migrate, deploy, smoke-test and roll back.                           |
| [`OPERATIONS.md`](../OPERATIONS.md)     | Monitoring, alerts, incidents, maintenance and operator procedures.         |

## Runbooks and evidence

| Document                                                                                 | Contents                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`backup-restore.md`](./backup-restore.md)                                               | Backup/restore runbook, targets, drill and verification procedure. |
| [`index-review.md`](./index-review.md)                                                   | Index-by-index query review and the before/after benchmark.        |
| [`load-testing.md`](./load-testing.md)                                                   | How to run the k6 read load test, thresholds and measured results. |
| [`../infra/prometheus/alerts.yml`](../infra/prometheus/alerts.yml)                       | Alert rules and thresholds.                                        |
| [`../infra/prometheus/prometheus.yml`](../infra/prometheus/prometheus.yml)               | Scrape configuration.                                              |
| [`../infra/grafana/dashboards/platform.json`](../infra/grafana/dashboards/platform.json) | Provisioned Grafana dashboard.                                     |

## Suggested reading order

1. `README.md` for the product and local setup.
2. `ARCHITECTURE.md` for how the system fits together.
3. `SECURITY.md` before exposing any environment.
4. `DEPLOYMENT.md` before the first deploy.
5. `OPERATIONS.md` when you are on call.
6. `PROJECT.md` when you need the authoritative requirements or test matrix.

## Documentation status

These guides were verified against the repository on **2026-11-01**. The project
is not fully production-ready:

- Phases 0–5, 7 and 8 are shipped; 6, 9 and 10 are partial.
- No real AI, social, email or billing provider has been exercised.
- The Vercel production deployment is marketing-only and has no API host.
- Docker-dependent checks (full compose stack, Grafana rendering) have not been
  run in this environment. CI runs the compose/E2E path.

When behavior changes, update the relevant guide in the same change. Do not let a
runbook describe a system that no longer exists.
