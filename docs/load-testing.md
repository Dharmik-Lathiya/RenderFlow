# Load testing

Phase 10 asks for a load test. [`tests/load/api-read.js`](../tests/load/api-read.js)
is a k6 read test for the two public endpoints that matter on a cold page load:

- `GET /api/v1/credits/pricing` — a real PostgreSQL read, weighted 80%;
- `GET /health/live` — the process, no I/O, weighted 20%.

The 4:1 split keeps most measured traffic on the database path rather than the
probe.

**It is not a write or queue-drain test.** It creates no data, does not exercise
authentication, and does not measure how fast a worker drains a backlog. Those
tests still need to be written. See [Limitations](#limitations).

## Running it

Install k6 (v2.x is what was used) and start the API against a disposable stack:

```bash
# Terminal 1: compose or a local API with mock providers
docker compose up -d postgres redis minio minio-init
pnpm db:migrate
pnpm db:seed
pnpm dev

# Terminal 2
BASE_URL=http://127.0.0.1:4000 k6 run tests/load/api-read.js
```

Optional environment variables:

| Variable   | Default                 | Meaning                          |
| ---------- | ----------------------- | -------------------------------- |
| `BASE_URL` | `http://127.0.0.1:4000` | API origin, no `/api/v1` suffix. |
| `RATE`     | `200`                   | Requests per second.             |
| `DURATION` | `30s`                   | Measured window.                 |

Do not point this at production. It creates no data, but 200 RPS for 30 seconds
is still traffic.

## Thresholds

The run fails if any threshold fails:

| Threshold                                 | Target    | Why                                                         |
| ----------------------------------------- | --------- | ----------------------------------------------------------- |
| `http_req_failed`                         | `< 1%`    | A load test that tolerates errors measures the wrong thing. |
| `http_req_duration{endpoint:pricing}` p95 | `< 300ms` | Database-backed public read.                                |
| `http_req_duration{endpoint:live}` p95    | `< 300ms` | Process liveness.                                           |

`setup()` warms the API and connection pool before the measured window. Without
it, the first requests pay for lazy initialisation and can move p95 on a short
run. It also fails immediately if the API is unreachable instead of reporting a
threshold breach that looks like a performance problem.

## Measured result

Local run on 2026-10-29 against a locally started API and PostgreSQL, with mock
providers:

| Property    | Result                    |
| ----------- | ------------------------- |
| Scenario    | constant arrival, 200 RPS |
| Duration    | 30s                       |
| Requests    | 6,003                     |
| Failures    | 0                         |
| Pricing p95 | 8.69 ms                   |
| Live p95    | 4.70 ms                   |
| Thresholds  | all passed                |

This is a single-process, single-database measurement on a development machine.
It is evidence that the read path is not obviously pathological at 200 RPS; it is
not a capacity plan. Production needs a run against the real database size,
connection limits, TLS termination and proxy path.

## CI

There is **no k6 job in CI** yet. The script is manual. CI runs lint, typecheck,
unit, integration, backup/restore, chaos and the compose E2E journey.

Adding a CI job needs a decision about the target: a compose API with mock
providers, a disposable Postgres, and a k6 binary installed in the runner. That
job should run on a schedule rather than every PR, because a 30-second 200 RPS
run is noisy on shared runners.

## Limitations

- **Read-only.** No generation, scheduling, publishing or credit movement.
- **No queue drain measurement.** A separate test must enqueue work and measure
  time-to-completion under load.
- **No authenticated traffic.** Login, SSE and admin paths are excluded.
- **No frontend measurement.** This measures the API, not Next.js rendering or
  Vercel cold starts.
- **Single API instance.** The API is not horizontally scalable until the rate
  limiter uses a shared store.
- **Development hardware.** Absolute latency numbers will differ in production.
- **No sustained soak.** 30 seconds does not reveal connection leaks or memory
  growth. A longer soak is a separate exercise.

When adding write or queue tests, use a disposable environment and mock providers
so the test never spends real provider money or touches real social accounts.
