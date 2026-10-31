/* global __ENV -- provided by the k6 runtime, not Node. */
import http from 'k6/http';
import { check } from 'k6';

/**
 * Phase 10 read load test (PROJECT.md section 13.5).
 *
 * Target: p95 < 300 ms at 200 requests/second for reads. Two public endpoints:
 * `GET /api/v1/credits/pricing` (a real database read; the marketing page renders
 * from it) and `GET /health/live` (the process, no I/O). The split is 4:1, so
 * most of the measured traffic exercises the query path rather than the probe.
 *
 * Run against a locally started API:
 *
 *   BASE_URL=http://127.0.0.1:4000 k6 run tests/load/api-read.js
 *
 * The thresholds fail the run, so "PASS" means the target was met. Do not point
 * this at a real deployment: it creates no data, but 200 RPS for 30 s is still
 * traffic. The compose stack with mock providers is the intended target.
 */

const BASE_URL = (__ENV.BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const RATE = Number(__ENV.RATE ?? 200);
const DURATION = __ENV.DURATION ?? '30s';

export const options = {
  discardResponseBodies: true,
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
      gracefulStop: '2s',
    },
  },
  thresholds: {
    // A load test that tolerates errors is measuring the wrong thing.
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:pricing}': ['p(95)<300'],
    'http_req_duration{endpoint:live}': ['p(95)<300'],
  },
};

/**
 * Warm the process and the connection pool before the measured window.
 *
 * Without this the first few requests pay for lazy initialisation, which at a
 * 200 RPS arrival rate is a handful of slow samples that can move p95 on a short
 * run. It also fails the run immediately when the API is not reachable, instead
 * of reporting a threshold breach that looks like a performance problem.
 */
export function setup() {
  const responses = http.batch([
    ['GET', `${BASE_URL}/health/live`],
    ['GET', `${BASE_URL}/api/v1/credits/pricing`],
  ]);

  for (const response of responses) {
    if (response.status !== 200) {
      throw new Error(`warm-up failed: ${response.url} returned ${response.status}`);
    }
  }

  return { baseUrl: BASE_URL };
}

export default function () {
  // 4:1 in favour of the database-backed read.
  const pricing = Math.random() < 0.8;
  const url = pricing ? `${BASE_URL}/api/v1/credits/pricing` : `${BASE_URL}/health/live`;

  const response = http.get(url, {
    tags: { endpoint: pricing ? 'pricing' : 'live' },
  });

  check(response, {
    'status is 200': (result) => result.status === 200,
  });
}
