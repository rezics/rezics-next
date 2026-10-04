import { randomUUID } from 'node:crypto';
import {
  GRAPHS,
  DATASET,
  PROFILE,
  PUBLIC_SEARCH_ANCHOR,
  RV,
  TEXT_INDEX_PROFILE,
  lit,
  iri,
  type WorkActivationEnvironment,
} from '../../../services/main/src/modules/work/activate.ts';
import { PUBLIC_SEARCH_GRAPH } from '../../../services/main/src/modules/work/select-main.ts';

/** The management probe asserts a complete population and changes global
 * classification/restore fences. Keep previous sequential files' graph cut
 * intact while the probe uses its own migrated owner databases. */
export async function isolateDiscoveryProbeGraph(environment: WorkActivationEnvironment) {
  const fuseki = environment.fuseki;
  const originalLineage = environment.lineage;
  const prefix = `urn:rezics:qa:g1064:projection:${randomUUID()}`;
  const graphs = [...Object.values(GRAPHS), PUBLIC_SEARCH_GRAPH];
  await fuseki.update(
    graphs
      .map(
        (graph, index) => `COPY SILENT GRAPH ${iri(graph)} TO GRAPH ${iri(`${prefix}:${index}`)}`,
      )
      .join(';\n'),
  );
  const restore = async () => {
    environment.lineage = originalLineage;
    await fuseki.update(
      graphs
        .flatMap((graph, index) => [
          `CLEAR SILENT GRAPH ${iri(graph)}`,
          `ADD SILENT GRAPH ${iri(`${prefix}:${index}`)} TO GRAPH ${iri(graph)}`,
          `DROP SILENT GRAPH ${iri(`${prefix}:${index}`)}`,
        ])
        .join(';\n'),
    );
  };
  try {
    await fuseki.update(graphs.map((graph) => `CLEAR SILENT GRAPH ${iri(graph)}`).join(';\n'));
    const lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };
    // The command bootstrap correctly refuses the saved graphs. This is raw
    // fixture preparation; every operation under test still uses real APIs.
    await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)}
        rv:dataEpoch ${lit(lineage.dataEpoch)};rv:routingEpoch ${lit(lineage.routingEpoch)};
        rv:sequence 0;rv:modelHead ${iri(PROFILE)};rv:shapeHead ${iri(PROFILE)};
        rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)};
        rv:textIndexGeneration ${iri(`urn:rezics:text-index-generation:${randomUUID()}`)} }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor }
    }`);
    environment.lineage = lineage;
    return restore;
  } catch (error) {
    await restore();
    throw error;
  }
}
