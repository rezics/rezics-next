import type { Pool } from 'pg';
import { metadataWorkRequestDigest } from '../work/activate.ts';
import type { OpenLibrarySourceGraph, SourceGraphProjection } from './graph-projection.ts';
import type { OpenLibraryConversionStore } from './open-library-conversion.ts';
import type { StagedSourceObservation } from './intake.ts';

export class SourceProposalInvalid extends Error {}
export class SourceProposalMissingGraph extends Error {}
export class SourceProposalUnavailable extends Error {}

export interface NativeWorkSourceProposal {
  profile: 'open-library-native-work-proposal-v1';
  state: 'proposed';
  proposal: string;
  target: 'new-native-work';
  record: string;
  observation: string;
  conversion: string;
  sourceDigest: string;
  candidateTitle: string;
  semanticTypes: [];
  sourceOnlyFields: ['description', 'authors', 'subjects'];
  rightsEvidence: StagedSourceObservation['rightsEvidence'];
  rightsStatus: 'undetermined';
  graphReceipt: string;
  graphPosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  createdAt: string;
}

interface ProposalRow {
  id: string; conversion_id: string; observation_id: string; record_id: string;
  principal_id: string; source_digest: string; candidate_title: string;
  rights_evidence: StagedSourceObservation['rightsEvidence'];
  graph_receipt: string; graph_data_epoch: string; graph_sequence: string;
  created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (uri: string): string => uri.split('/').at(-1)!;
const url = (value: string): string => `https://rezics.com/id/${value}`;

function result(row: ProposalRow): NativeWorkSourceProposal {
  return { profile: 'open-library-native-work-proposal-v1', state: 'proposed',
    proposal: url(row.id), target: 'new-native-work', record: url(row.record_id),
    observation: url(row.observation_id), conversion: url(row.conversion_id),
    sourceDigest: row.source_digest, candidateTitle: row.candidate_title,
    semanticTypes: [], sourceOnlyFields: ['description', 'authors', 'subjects'],
    rightsEvidence: row.rights_evidence, rightsStatus: 'undetermined',
    graphReceipt: row.graph_receipt,
    graphPosition: { datasetId: 'product', dataEpoch: row.graph_data_epoch,
      sequence: row.graph_sequence }, createdAt: row.created_at.toISOString() };
}

function verify(row: ProposalRow, graph: SourceGraphProjection,
  observation: StagedSourceObservation): void {
  if (url(row.record_id) !== graph.record || url(row.observation_id) !== graph.observation
    || url(row.conversion_id) !== graph.conversion || row.source_digest !== graph.sourceDigest
    || row.candidate_title !== graph.projection.title || row.graph_receipt !== graph.receipt
    || JSON.stringify(row.rights_evidence) !== JSON.stringify(observation.rightsEvidence)) {
    throw new SourceProposalUnavailable('proposal differs from retained source evidence');
  }
}

export class SourceNativeWorkProposalStore {
  constructor(private readonly pool: Pool, private readonly graph: OpenLibrarySourceGraph,
    private readonly conversions: OpenLibraryConversionStore) {}

  async propose(principalId: string, conversionId: string):
    Promise<{ proposal: NativeWorkSourceProposal; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(conversionId)) {
      throw new SourceProposalInvalid('invalid source proposal identity');
    }
    const evidence = await this.conversions.verifiedRead(principalId, conversionId);
    if (!evidence) return null;
    const graph = await this.graph.read(principalId, conversionId);
    if (!graph) throw new SourceProposalMissingGraph('source graph has not been projected');
    const { conversion, observation } = evidence;
    if (graph.record !== observation.record || graph.observation !== observation.observation
      || graph.conversion !== conversion.conversion || graph.sourceDigest !== conversion.sourceDigest
      || graph.projection.title !== conversion.projection.title) {
      throw new SourceProposalUnavailable('graph differs from retained source evidence');
    }
    try { metadataWorkRequestDigest(conversion.projection.title); }
    catch { throw new SourceProposalInvalid('source title cannot be proposed for a native Work'); }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const inserted = await client.query<{ id: string }>(`INSERT INTO source.native_work_proposal
        (id, conversion_id, observation_id, record_id, principal_id, source_digest,
         candidate_title, rights_evidence, graph_receipt, graph_data_epoch, graph_sequence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (conversion_id) DO NOTHING RETURNING id`,
      [Bun.randomUUIDv7(), conversionId, id(observation.observation), id(observation.record),
        principalId, conversion.sourceDigest, conversion.projection.title,
        JSON.stringify(observation.rightsEvidence), graph.receipt,
        graph.sourcePosition.dataEpoch, graph.sourcePosition.sequence]);
      const rows = await client.query<ProposalRow>(`SELECT * FROM source.native_work_proposal
        WHERE conversion_id = $1 AND principal_id = $2`, [conversionId, principalId]);
      const row = rows.rows[0];
      if (!row) throw new SourceProposalUnavailable('proposal cannot be read');
      verify(row, graph, observation);
      await client.query('COMMIT');
      return { proposal: result(row), replayed: inserted.rowCount === 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async read(principalId: string, proposalId: string): Promise<NativeWorkSourceProposal | null> {
    if (!UUID.test(principalId) || !UUID.test(proposalId)) {
      throw new SourceProposalInvalid('invalid source proposal identity');
    }
    const rows = await this.pool.query<ProposalRow>(`SELECT * FROM source.native_work_proposal
      WHERE id = $1 AND principal_id = $2`, [proposalId, principalId]);
    const row = rows.rows[0];
    if (!row) return null;
    const evidence = await this.conversions.verifiedRead(principalId, row.conversion_id);
    const graph = await this.graph.read(principalId, row.conversion_id);
    if (!evidence || !graph) throw new SourceProposalUnavailable('proposal source graph is unavailable');
    verify(row, graph, evidence.observation);
    return result(row);
  }
}
