import { m } from '../../paraglide/messages.js';
import type { ExportFailureKind, ExportState } from './contract';

export function exportSectionLabel(section: string): string {
  if (section === 'entries') return m.library_export_section_entries();
  if (section === 'labels') return m.library_export_section_labels();
  if (section === 'assignments') return m.library_export_section_assignments();
  if (section === 'sessions') return m.library_export_section_sessions();
  if (section === 'units') return m.library_export_section_units();
  if (section === 'history') return m.library_export_section_history();
  if (section === 'holdings') return m.library_export_section_holdings();
  if (section === 'collections') return m.library_export_section_collections();
  if (section === 'collectionPins') return m.library_export_section_pins();
  if (section === 'occurrences') return m.library_export_section_occurrences();
  if (section === 'bangumiUploads' || section === 'bangumiEvidence') return m.library_export_section_bangumi();
  if (section === 'malImports' || section === 'malEvidence') return m.library_export_section_mal();
  return m.library_export_section_other({ section });
}

export function exportFailureLabel(kind: ExportFailureKind, detail?: string): string {
  if (kind === 'denied') return m.library_export_denied();
  if (kind === 'not-found') return m.library_export_not_found();
  if (kind === 'conflict') return m.library_export_conflict();
  if (kind === 'idempotency') return m.library_export_idempotency();
  if (kind === 'invalid-cursor') return m.library_export_invalid_cursor();
  if (kind === 'malformed')
    return detail ? m.library_export_malformed_detail({ detail }) : m.library_export_malformed();
  return m.library_export_unavailable();
}

export function exportTerminalLabel(state: ExportState): string {
  if (state === 'stale') return m.library_export_stale();
  if (state === 'cancelled') return m.library_export_cancelled();
  if (state === 'expired') return m.library_export_expired();
  if (state === 'limit') return m.library_export_limit();
  return m.library_export_unavailable();
}
