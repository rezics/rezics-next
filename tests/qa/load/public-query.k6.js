import { check, sleep } from 'k6';
import http from 'k6/http';

// A fixed, reproducible smoke load on Main's real Fuseki-backed public query path.
export const options = {
  scenarios: {
    public_phrase: { executor: 'constant-vus', vus: 2, duration: '20s', gracefulStop: '5s' },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<1500'],
    http_reqs: ['count>=20'],
    checks: ['rate==1'],
  },
};

const phrases = ['cedar atlas', 'harbor lantern'];

export default function () {
  const response = http.post(`${__ENV.MAIN_BASE_URL}/v1/queries`, JSON.stringify({
    profile: 'public-main-phrase-v1', phrase: phrases[__ITER % phrases.length], language: null,
  }), { headers: { 'content-type': 'application/json' }, tags: { profile: 'public-main-phrase-v1' },
    timeout: '5s' });
  let body;
  try { body = response.json(); } catch { body = null; }
  check(response, {
    'Main/Fuseki returns a complete empty-corpus query snapshot': r => r.status === 200
      && body?.contractVersion === '1' && body?.complete === true
      && body?.population === 0 && body?.total === 0
      && body?.sourcePosition?.datasetId === 'product'
      && typeof body?.sourcePosition?.sequence === 'string'
      && typeof body?.indexGeneration === 'string',
  });
  sleep(0.1);
}
