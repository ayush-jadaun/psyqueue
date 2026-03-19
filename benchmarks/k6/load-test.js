import http from 'k6/http'
import { check } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const errors = new Rate('errors')
const enqueueTime = new Trend('enqueue_time', true)

const BASE = __ENV.TARGET || 'http://localhost:3001'

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 20 },
        { duration: '20s', target: 50 },
        { duration: '20s', target: 100 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    errors: ['rate<0.05'],
  },
}

export default function () {
  const payload = JSON.stringify({
    payload: {
      userId: Math.floor(Math.random() * 10000),
      action: 'process',
      ts: Date.now(),
      data: 'x'.repeat(100),
    },
  })

  const res = http.post(`${BASE}/enqueue`, payload, {
    headers: { 'Content-Type': 'application/json' },
  })

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'has id': (r) => { try { return JSON.parse(r.body).id !== undefined } catch { return false } },
  })

  errors.add(!ok)
  enqueueTime.add(res.timings.duration)
}
