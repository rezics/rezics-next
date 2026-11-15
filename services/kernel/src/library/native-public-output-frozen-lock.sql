-- The terminal disposer selected this exact public output. Its original publication proof remains held.
SELECT 1
FROM library.native_public_output_binding b
JOIN library.collection c ON c.route=b.route AND c.collection_id=b.collection_id
JOIN access.account a ON a.route=c.route AND a.account_id=c.curator_account_id
JOIN library.collection_retained_output f
 ON f.route=c.route AND f.collection_id=c.collection_id AND f.generation=b.output_generation
JOIN library.collection_source_output_publication r ON (r.route,r.collection_id,r.generation)=(f.route,f.collection_id,f.generation)
WHERE b.partition_no=$1 AND b.capture_id=$2
 AND c.state='active' AND c.visibility='public' AND c.source_generation=f.source_generation
 AND c.membership_kind='dynamic' AND c.builtin_kind IN ('everything','state')
 AND a.state='deleted' AND a.authn_fenced
 AND r.account_id=a.account_id AND r.incarnation=b.incarnation
 AND f.source_generation=b.activation_source_generation AND f.source_generation=r.source_generation
 AND f.transaction_id=b.activation_transaction_id AND f.transaction_id=r.transaction_id
 AND f.native_xid=r.native_xid AND f.members=r.expected_members AND f.member_fence=r.member_fence
FOR SHARE OF a,f,r;
