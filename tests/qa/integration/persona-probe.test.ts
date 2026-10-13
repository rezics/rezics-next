import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { redactProbe, resolveProbeCall, probeHeaders, probePersonas, type ProbeCall, type ProbeResult } from '../../../scripts/goal/persona.ts';
import { personaNames, personaSessions } from '../support/personas.ts';

const input = process.env.REZICS_PERSONA_PROBE_INPUT;
const output = process.env.REZICS_PERSONA_PROBE_OUTPUT;
const request = input && output ? JSON.parse(readFileSync(input, 'utf8')) as {
  visibility: 'public' | 'private'; calls: ProbeCall[];
} : undefined;

test.skipIf(!request)('persona probe runs ordered calls in one fixture', async () => {
  expect(probePersonas).toEqual(personaNames);
  const result: ProbeResult = { visibility: request!.visibility, setupSeconds: 0, calls: [] };
  let sessions: Awaited<ReturnType<typeof personaSessions>> | undefined;
  try {
    sessions = await personaSessions(request!.visibility);
    result.setupSeconds = sessions.elapsedSeconds;
    for (const template of request!.calls) {
      const call = resolveProbeCall(template, sessions, result.calls);
      const started = performance.now();
      const response = await sessions[call.persona].main(call.method, call.path, call.body);
      const text = await response.text();
      let answer: unknown = null;
      if (text) {
        try { answer = JSON.parse(text); } catch { answer = text; }
      }
      const headers = Object.fromEntries(probeHeaders.flatMap(name => {
        const value = response.headers.get(name);
        return value === null ? [] : [[name, value]];
      }));
      result.calls.push(redactProbe({ ...call, status: response.status, headers, answer,
        elapsedSeconds: (performance.now() - started) / 1000 }) as typeof result.calls[number]);
    }
  } catch {
    // Errors from setup and fetch may include request credentials; expose only a fixed diagnostic.
    result.error = `Persona probe failed during ${sessions ? `call ${result.calls.length + 1}` : 'setup'}`;
  } finally {
    try { await sessions?.close(); } catch { result.error = 'Persona probe failed during shutdown'; }
    writeFileSync(output!, JSON.stringify(redactProbe(result)), { mode: 0o600 });
  }
  expect(result.error).toBeUndefined();
}, 120_000 + (request?.calls.length ?? 0) * 45_000);
