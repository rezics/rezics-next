import { readCommandReceipt } from '../context/command.ts';
import { readSemanticTerminal } from '../semantic/command.ts';
import { NativeBasisVerificationProblem, verifyAcknowledgedSemanticBasis,
  type AcknowledgedSemanticBasis } from '../semantic/native-basis.ts';
import { STATEMENT_FAMILIES } from '../statement/receipt-family.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { SourceFieldProblem, mappingUnverified, supportChanged, supportUnavailable,
  type VerifiedNativeAcknowledgement } from './field-support-contract.ts';
import type { NativeSupportVerifier, SourceNativeVerifiers } from './field-support-native.ts';

export type AcknowledgedSourceNativeDependencies = Parameters<typeof verifyAcknowledgedSemanticBasis>[0];

async function readTerminal(work: AcknowledgedSourceNativeDependencies,native: AcknowledgedSemanticBasis) {
  const env = work.environment;
  if (native.kind === 'component-property') return readSemanticTerminal(env,native.receipt);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(native.receipt)} a rv:OperationReceipt ;
      rv:commandFamily "${STATEMENT_FAMILIES.record}" ; rv:outcome rv:Succeeded ; rv:admissionId ?admission }
  } LIMIT 2`)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.admission) return supportUnavailable();
  return readCommandReceipt(env,rows[0].admission.value,STATEMENT_FAMILIES.record);
}

/** Compose the actual Semantic/Statement owner after Source has independently
 * resolved and verified the retained coordinate. This verifies current admission;
 * private historical replay uses Source's immutable saved acknowledgement instead.
 * The native fence precedes Source settlement, not an atomic cross-owner commit. */
export function acknowledgedSemanticSupportOwners(work: AcknowledgedSourceNativeDependencies):
  Required<Pick<SourceNativeVerifiers, 'semantic' | 'statement'>> {
  const verify: NativeSupportVerifier = async (input,requireCurrent,context) => {
    const native = input.native;
    if (native.owner !== 'semantic' && native.owner !== 'statement') return mappingUnverified();
    if (!requireCurrent || !context?.selected) return supportUnavailable();
    try {
      const basis = await verifyAcknowledgedSemanticBasis(work,context.principal,{
        actingSubject: input.actingSubject,native,selected: context.selected,
      });
      // The native owner resolves the actual terminal receipt. Do not reconstruct
      // an admission ID, scope or operation from a component/revision ID.
      const terminal = basis.commandReceipt;
      if (!terminal || terminal.outcome !== 'succeeded') return supportUnavailable();
      const component = native.kind === 'statement' ? native.statement : native.component;
      if (terminal.receipt !== basis.receipt || terminal.component !== component || terminal.revision !== basis.revision
        || terminal.operation !== basis.operation
        || terminal.dataEpoch !== basis.sourcePosition.dataEpoch || terminal.sequence !== basis.sourcePosition.sequence) {
        return supportChanged('native-head');
      }
      const acknowledgement: VerifiedNativeAcknowledgement = {
        receipt: terminal.receipt,admissionId: terminal.admissionId,scope: terminal.scope,
        dataEpoch: terminal.dataEpoch,sequence: terminal.sequence,
        action: native.kind === 'statement' ? 'statement.record' : 'semantic.change',component,revision: basis.revision,
        semantic: { operation: basis.operation,manifest: basis.manifest,modelGeneration: basis.modelGeneration,
          headGuarantee: basis.headGuarantee,commandReceipt: terminal,
          ...(basis.occurrenceAdoption ? { occurrenceAdoption: basis.occurrenceAdoption } : {}) },
      };
      return acknowledgement;
    } catch (error) {
      if (error instanceof NativeBasisVerificationProblem) {
        if (error.code === 'native_target_mismatch') return supportChanged('native-target');
        if (error.code === 'native_value_mismatch') return supportChanged('native-value');
        if (error.code === 'native_head_mismatch') return supportChanged('native-head');
        if (error.code === 'native_receipt_mismatch') {
          // Missing owner evidence is not a disclosed mismatch with an existing
          // acknowledged command. Neither refusal creates a Source settlement.
          const terminal = await readTerminal(work,native);
          if (!terminal || terminal.outcome !== 'succeeded') return supportUnavailable();
          return supportChanged('native-head');
        }
        if (error.status === 403) throw new SourceFieldProblem(403,error.code,error.message);
        return supportUnavailable();
      }
      if (error instanceof SourceFieldProblem) throw error;
      return supportUnavailable();
    }
  };
  return { semantic: verify,statement: verify };
}
