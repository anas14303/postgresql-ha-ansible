import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom error-rate metric, mirrors the Nexus k6 script pattern
export const errors = new Rate('errors');

const PATRONI_HOST = __ENV.PATRONI_HOST || '127.0.0.1';
const PATRONI_PORT = __ENV.PATRONI_PORT || '8008';
const BASE = `http://${PATRONI_HOST}:${PATRONI_PORT}`;

export const options = {
  thresholds: {
    // 95% of requests must complete under 500ms — Patroni's REST API
    // is a lightweight health surface, not a query path, so this is strict.
    http_req_duration: ['p(95)<500'],
    errors: ['rate<0.05'],
  },
};

// Mixed workload against Patroni's REST API, the same surface HAProxy
// and monitoring hit continuously in production:
//   ~50% /health       — liveness probe (what HAProxy would check)
//   ~30% /patroni       — full state (what Prometheus/monitoring would poll)
//   ~20% /leader        — leader-only check (what a smart client/proxy uses)
export default function () {
  const roll = Math.random();
  let res;

  if (roll < 0.5) {
    res = http.get(`${BASE}/health`);
  } else if (roll < 0.8) {
    res = http.get(`${BASE}/patroni`);
  } else {
    res = http.get(`${BASE}/leader`);
  }

  const ok = check(res, {
    'status is 200 or 503': (r) => r.status === 200 || r.status === 503,
    'body is non-empty': (r) => r.body && r.body.length > 0,
  });

  errors.add(!ok);
  sleep(0.1);
}
