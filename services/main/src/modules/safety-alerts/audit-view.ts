/** The offline subject rewrite detaches only this typed column, then restores
 * its UTF-8 text projection in the same transaction. CREATE OR REPLACE retains
 * the view identity, grants and downstream audit views throughout the switch.
 * View options must be carried explicitly; replacement resets omitted options:
 * https://www.postgresql.org/docs/18/sql-createview.html */
export function safetyAlertDeliveryViewSql(
  subjectFormat: 'detached' | 'bytea',
  options: readonly string[],
) {
  if (options.length > 3) throw new Error('Safety audit view options are invalid');
  const settings = options.map((option) => {
    const match =
      /^(security_barrier|security_invoker)=(true|false)$|^(check_option)=(local|cascaded)$/.exec(
        option,
      );
    if (!match) throw new Error('Safety audit view option is unsupported');
    return match[1] ? `${match[1]}=${match[2]}` : `${match[3]}='${match[4]}'`;
  });
  const subject =
    subjectFormat === 'detached' ? 'NULL::text' : "convert_from(p.account_subject, 'UTF8')";
  return `CREATE OR REPLACE VIEW access.safety_alert_delivery
    ${settings.length ? `WITH (${settings.join(',')})` : ''} AS
    SELECT a.id AS alert_id, a.case_id, a.step_id, a.case_generation, a.principal_id,
      p.account_issuer, ${subject} COLLATE "default" AS account_subject, a.responder, a.reason, a.due_at,
      a.created_at, a.state AS intake_state, a.queued_at, a.item_id,
      d.id AS delivery_id, d.channel, d.state AS delivery_state,
      d.attempt_count, d.provider_message_id, d.diagnostic, d.cancel_reason, d.terminal_at
    FROM access.safety_alert a JOIN access.principal p ON p.id = a.principal_id
    LEFT JOIN access.notification_delivery d ON d.item_id = a.item_id`;
}
