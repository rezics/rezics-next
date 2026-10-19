import { readCommandReceipt } from '../context/command.ts';
import { readSemanticTerminal } from '../semantic/command.ts';
import { NativeBasisVerificationProblem, verifyAcknowledgedSemanticBasis } from '../semantic/native-basis.ts';
import { STATEMENT_FAMILIES } from '../statement/receipt-family.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { SourceFieldProblem, mappingUnverified, supportChanged, supportUnavailable,
  type VerifiedNativeAcknowledgement } from './field-support-contract.ts';
import type { NativeSupportVerifier, SourceNativeVerifiers } from './field-support-native.ts';

export type AcknowledgedSourceNativeDependencies = Parameters<typeof verifyAcknowledgedSemanticBasis>[0];

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
      const env = work.environment;
      // Admission IDs and scopes come from the terminal receipt, never from a
      // component/revision ID or a reconstructed action name.
      let terminal: Awaited<ReturnType<typeof readSemanticTerminal>> | Awaited<ReturnType<typeof readCommandReceipt>>;
      if (native.kind === 'component-property') terminal = await readSemanticTerminal(env,basis.receipt);
      else {
        const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?admission WHERE {
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(basis.receipt)} a rv:OperationReceipt ;
            rv:commandFamily "${STATEMENT_FAMILIES.record}" ; rv:outcome rv:Succeeded ;
            rv:operation ${iri(basis.operation)} ; rv:component ${iri(native.statement)} ;
            rv:revision ${iri(basis.revision)} ; rv:admissionId ?admission }
        } LIMIT 2`)).results?.bindings ?? [];
        if (rows.length !== 1 || !rows[0]?.admission) return supportUnavailable();
        terminal = await readCommandReceipt(env,rows[0].admission.value,STATEMENT_FAMILIES.record);
        if (terminal?.outcome === 'succeeded' && terminal.operation !== basis.operation) return supportChanged('native-head');
      }
      if (!terminal || terminal.outcome !== 'succeeded') return supportUnavailable();
      const component = native.kind === 'statement' ? native.statement : native.component;
      if (terminal.receipt !== basis.receipt || terminal.component !== component || terminal.revision !== basis.revision
        || terminal.dataEpoch !== basis.sourcePosition.dataEpoch || terminal.sequence !== basis.sourcePosition.sequence) {
        return supportChanged('native-head');
      }
      const acknowledgement: VerifiedNativeAcknowledgement = {
        receipt: terminal.receipt,admissionId: terminal.admissionId,scope: terminal.scope,
        dataEpoch: terminal.dataEpoch,sequence: terminal.sequence,
        action: native.kind === 'statement' ? 'statement.record' : 'semantic.change',component,revision: basis.revision,
        semantic: { operation: basis.operation,manifest: basis.manifest,modelGeneration: basis.modelGeneration,
          headGuarantee: basis.headGuarantee },
      };
      return acknowledgement;
    } catch (error) {
      if (error instanceof NativeBasisVerificationProblem) {
        if (error.code === 'native_target_mismatch') return supportChanged('native-target');
        if (error.code === 'native_value_mismatch') return supportChanged('native-value');
        if (error.code === 'native_head_mismatch' || error.code === 'native_receipt_mismatch') return supportChanged('native-head');
        if (error.status === 403) throw new SourceFieldProblem(403,error.code,error.message);
        return supportUnavailable();
      }
      if (error instanceof SourceFieldProblem) throw error;
      return supportUnavailable();
    }
  };
  return { semantic: verify,statement: verify };
}
