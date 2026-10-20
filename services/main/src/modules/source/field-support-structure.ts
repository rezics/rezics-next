import { canonicalJson } from '../../../../../scripts/lib/canonical-json.ts';
import { checkEpisodeOrder } from '../structure/episode-profile.ts';
import {
  readAcknowledgedStructureOccurrence,
  StructureNativeBasisProblem,
} from '../structure/native-basis.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import {
  currentWorkReadSession,
  WorkReadMoved,
  WorkReadUnavailable,
} from '../work/read-session.ts';
import type { SourceNativeWorkAdoptionStore } from './native-work-adoption.ts';
import { suppliedLanguage } from './field-control-language.ts';
import {
  SourceFieldProblem,
  mappingUnverified,
  supportChanged,
  supportUnavailable,
} from './field-support-contract.ts';
import {
  episodeOccurrenceField,
  episodeRational,
  episodeKindCode,
} from './field-support-episode.ts';
import type { NativeSupportVerifier, SourceNativeVerifiers } from './field-support-native.ts';

export interface AcknowledgedSourceStructureDependencies {
  /** Existing Source owner, including immutable native adoption and withdrawal
   * verification. An importer journal or a caller-supplied Work map is not this. */
  sourceAdoptions: Pick<SourceNativeWorkAdoptionStore, 'importBinding'>;
}

/** Source correspondence consumes the native owner in the caller's exact fenced
 * session. It neither runs a converter nor creates/adopts an occurrence. */
export function acknowledgedStructureSupportOwners(
  deps: AcknowledgedSourceStructureDependencies,
): Required<Pick<SourceNativeVerifiers, 'structure'>> {
  const structure: NativeSupportVerifier = async (input, requireCurrent, context) => {
    const native = input.native;
    if (native.kind !== 'structure-occurrence' || native.profile !== 'episode-list-v1')
      return mappingUnverified();
    const session = context?.session,
      evidence = context?.evidence;
    if (
      !requireCurrent ||
      !session ||
      currentWorkReadSession() !== session ||
      !evidence ||
      !context?.selected
    )
      return supportUnavailable();
    session.checkDeadline();
    if (
      !session.principal ||
      session.principal.issuer !== context.principal.issuer ||
      session.principal.subject !== context.principal.subject
    ) {
      throw new SourceFieldProblem(
        403,
        'authority_denied',
        'The current reader and acting subject are required',
      );
    }
    const record = evidence.record,
      field = episodeOccurrenceField(input.evidence.field.pointer);
    if (record.provider !== 'bangumi' || record.kind !== 'episode' || !field)
      return mappingUnverified();
    if (
      input.context !== native.structure ||
      input.occurrence !== native.occurrence ||
      input.sourceOccurrence !== null ||
      input.slot !== `structure-occurrence-v1#qualifier.values.${field}`
    ) {
      return supportChanged('native-target');
    }
    if (!Object.hasOwn(record.data, 'id') || !Object.hasOwn(record.data, 'subject_id'))
      return supportUnavailable();
    if (
      String(record.data.id) !== record.externalId ||
      !/^[1-9][0-9]*$/.test(record.externalId) ||
      !/^[1-9][0-9]*$/.test(String(record.data.subject_id))
    )
      return supportChanged('record');
    try {
      const verified = await readAcknowledgedStructureOccurrence(session, native);
      const occurrence = verified.record;
      if (occurrence.sourceKey === undefined) return supportUnavailable();
      if (
        occurrence.sourceKey !== record.key ||
        occurrence.role !== 'episode' ||
        !occurrence.target
      )
        return supportChanged('native-target');
      let qualifier: ReturnType<typeof checkEpisodeOrder>;
      try {
        qualifier = checkEpisodeOrder(occurrence.qualifier);
      } catch {
        return supportChanged('native-value');
      }
      // The whole original placement must agree, including optional presence.
      // A second use of this Episode cannot inherit the first use's receipt.
      for (const [key, name] of [
        ['sort', 'position'],
        ['disc', 'disc'],
        ['type', 'kindCode'],
      ] as const) {
        const present = Object.hasOwn(record.data, key);
        if (!present) {
          if (
            name === 'position' ||
            Object.hasOwn(qualifier.values, name) ||
            (name === 'kindCode' && Object.hasOwn(qualifier.values, 'kindScheme'))
          )
            return supportChanged('native-value');
          continue;
        }
        const raw = record.data[key];
        const expected =
          name === 'kindCode' ? episodeKindCode(raw) : episodeRational(raw, name === 'disc');
        if (
          expected === null ||
          canonicalJson(expected) !== canonicalJson(qualifier.values[name]) ||
          (name === 'kindCode' && qualifier.values.kindScheme !== 'bangumi:episode:type')
        )
          return supportChanged('native-value');
      }
      const selected = record.data[input.evidence.field.pointer.slice('/data/'.length)];
      if (
        canonicalJson({ value: selected, language: suppliedLanguage(input.evidence.field) }) !==
        canonicalJson(context.selected)
      )
        return supportChanged('evidence-binding');
      const source = {
        provider: 'bangumi',
        namespace: 'subject',
        externalId: String(record.data.subject_id),
      };
      const readBinding = async () => {
        const binding = await deps.sourceAdoptions.importBinding(source);
        if (!binding) return supportUnavailable();
        await binding.assertActive();
        return {
          binding: binding.binding,
          work: binding.work,
          source: binding.source,
          record: binding.sourceRecord,
          conversion: binding.conversion,
          observation: binding.observation,
        };
      };
      const binding = await readBinding();
      session.observeDependency(
        `source-episode-parent:${record.key}:${native.target}`,
        binding,
        readBinding,
      );
      if (binding.work !== native.target || canonicalJson(binding.source) !== canonicalJson(source))
        return supportChanged('native-target');
      const readIdentity = async () =>
        (
          await session.deps.environment.fuseki.query(`PREFIX rv: <${RV}>
        SELECT ?provider ?namespace ?key WHERE { GRAPH ${iri(GRAPHS.current)} {
          ${iri(occurrence.target!)} <https://schema.org/identifier> ?identity .
          ?identity a rv:ExternalReference ; rv:externalProvider ?provider ; rv:externalNamespace ?namespace ; rv:externalKey ?key .
        } } LIMIT 65`)
        ).results?.bindings ?? [];
      const identities = await readIdentity();
      session.observeDependency(
        `source-episode-identity:${occurrence.target}`,
        identities,
        readIdentity,
      );
      if (!identities.length) return supportUnavailable();
      if (
        identities.length > 64 ||
        identities.filter(
          (row) => row.provider?.value === 'bangumi' && row.namespace?.value === 'episode',
        ).length !== 1 ||
        !identities.some(
          (row) =>
            row.provider?.value === 'bangumi' &&
            row.namespace?.value === 'episode' &&
            row.key?.value === record.externalId,
        )
      )
        return supportChanged('native-target');
      const receipt = verified.commandReceipt;
      if (
        (receipt.action !== undefined && receipt.action !== 'work.edit') ||
        receipt.scope !== `work:edit:${native.target}` ||
        receipt.receipt !== native.receipt ||
        receipt.structure !== native.structure ||
        receipt.revision !== native.revision
      )
        return supportChanged('native-head');
      session.checkDeadline();
      return {
        receipt: receipt.receipt,
        admissionId: receipt.admissionId,
        scope: receipt.scope,
        action: 'work.edit',
        component: native.component,
        revision: native.revision,
        dataEpoch: receipt.dataEpoch,
        sequence: receipt.sequence,
        structure: { ...verified, sourceBinding: binding.binding },
      };
    } catch (error) {
      if (error instanceof StructureNativeBasisProblem) {
        if (error.status === 403) throw new SourceFieldProblem(403, error.code, error.message);
        if (
          error.code === 'structure_head_mismatch' ||
          error.code === 'structure_occurrence_retired' ||
          error.code === 'structure_receipt_mismatch'
        )
          return supportChanged('native-head');
        if (error.code === 'structure_target_mismatch') return supportChanged('native-target');
      }
      if (
        error instanceof SourceFieldProblem ||
        error instanceof WorkReadMoved ||
        error instanceof WorkReadUnavailable
      )
        throw error;
      return supportUnavailable();
    }
  };
  return { structure };
}
