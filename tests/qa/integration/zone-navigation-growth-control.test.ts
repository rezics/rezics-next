import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { shutdownTelemetry, startTelemetry } from '../../../packages/observability/src/runtime.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { assertWorkCostAtScales, startWorkProfileSink } from '../support/work-profile.ts';
import {
  logWorkCostRatios,
  measureControlZone,
  measuredCounters,
  measureZoneSite,
  profileDump,
  restoreZoneCuts,
  routePathFor,
  type ScaledProfile,
  wiringProbe,
  writeProfileDump,
  zoneSiteReadCost,
} from '../support/zone-navigation-growth.ts';

test('Zone route cost with the same own entries stays constant as unrelated Works grow', async () => {
  const sink = startWorkProfileSink();
  // pg must load after the SDK installs its instrumentation hooks.
  startTelemetry('main', {
    ...process.env,
    ...sink.env,
    OTEL_SERVICE_NAME: 'main',
    OTEL_TRACES_SAMPLER_ARG: '1',
  });
  const { readRetainedSeed } = await import('../support/seed-checkpoints.ts');
  const { ZONE_ROUTE_COST } = await import('../../../services/main/src/modules/zone/route-cost.ts');
  const retained = readRetainedSeed();
  expect(retained.cuts.map((cut) => cut.manifest.dimensions.unrelatedWorks)).toEqual([4, 16, 64]);

  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Zone navigation control requires task goal QA run metadata');

  const qaStackDir = join(root, '.temp', 'stack', 'rezics-qa-' + qaRunId);
  expect(readEnv(join(qaStackDir, 'compose.env')).REZICS_STACK_STORAGE).toBe('persistent');

  const [small, large] = [retained.cuts[0]!, retained.cuts[2]!];
  let smallRoute: ScaledProfile | undefined;
  let controlRoute: ScaledProfile | undefined;
  try {
    await restoreZoneCuts({
      sink,
      qaRunId,
      retained,
      label: 'zone-navigation-control',
      cuts: [small, large],
      measure: async (cut, restored) => {
        const scale = cut.manifest.dimensions.unrelatedWorks;
        if (cut.manifest.scale !== 'small') {
          const control = await measureControlZone(sink, restored, { small, large: cut, scale });
          controlRoute = control.route.profile;
          return;
        }
        const segment = cut.population.zone.mounts[0]!.segment;
        await wiringProbe(sink, restored, routePathFor(cut.population.zone.id, segment), scale, cut.manifest.scale);
        const { routePath, presentationPath, route, presentation } = await measureZoneSite(
          sink, restored, cut.population.zone.id, segment, scale,
        );
        writeProfileDump('zone-control-check-route-small',
          profileDump('route', cut.manifest.scale, routePath, route.profile, restored.apps));
        writeProfileDump('zone-control-check-presentation-small',
          profileDump('presentation', cut.manifest.scale, presentationPath, presentation.profile, restored.apps));
        smallRoute = route.profile;
        console.log('Zone navigation small cut counters', JSON.stringify({
          scale: cut.manifest.scale,
          routes: measuredCounters(route.profile),
          presentation: measuredCounters(presentation.profile),
        }));
      },
    });

    if (!smallRoute || !controlRoute) throw new Error('The small cut and its control were not both measured');
    // The cuts co-grow the Zone's own entries with unrelated Works, so only the control, which keeps the
    // small cut's 4 own entries among 64 unrelated Works, isolates the unrelated axis for the route.
    const cost = zoneSiteReadCost(ZONE_ROUTE_COST);
    const routeAgainstControl = [smallRoute, controlRoute];
    logWorkCostRatios('zone-route-growth', routeAgainstControl, cost);
    assertWorkCostAtScales(routeAgainstControl, cost, 'zone-route-growth');
  } finally {
    await shutdownTelemetry();
    await sink.stop();
  }
}, 600_000);
