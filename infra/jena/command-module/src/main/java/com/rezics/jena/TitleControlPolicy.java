package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;

/** Native single-target control CAS. No network or SQL access inside the writer. */
final class TitleControlPolicy {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        RECEIPTS = uri(CommandPolicy.RECEIPTS), SOURCE = uri(CommandPolicy.SOURCE);
    private static final Node LABEL = uri("http://www.w3.org/2000/01/rdf-schema#label");
    record Snapshot(Node work, Node before, Node control, Node oldControl, BigInteger epoch,
                    String action, JsonObject intent, String language, String error) {}
    private static Snapshot error(String reason) { return new Snapshot(null, null, null, null, null, null, null, null, reason); }

    static Snapshot capture(DatasetGraph data, CommandPolicy.Plan plan, String receipt,
                            String digest, String update, JsonValue proof, byte[] key,
                            boolean protectedCommand) {
        // ProtectionPolicy validates the complete reviewed footprint and its own
        // Access-bound proof. The ordinary title path still rejects review-required.
        if (protectedCommand) return null;
        // Exact old revisions are immutable, including additions and type/manifest deletion.
        for (String subject : plan.revisions()) {
            if (data.contains(REVISIONS, uri(subject), RDF.type.asNode(), rv("EditorialControlRevision")))
                return error("old title control revision is immutable");
            Node component = one(data, REVISIONS, uri(subject), rv("component"));
            if (component != null && data.contains(CURRENT, component, rv("titleControlHead"), Node.ANY))
                return error("old controlled Work revision is immutable");
        }
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        Node control = template(modify.getInsertQuads(), RECEIPTS, uri(receipt), rv("titleControl"));
        boolean protectedTitle = false;
        List<Quad> all = new ArrayList<>(modify.getInsertQuads()); all.addAll(modify.getDeleteQuads());
        for (Quad q : all) {
            if (CURRENT.equals(q.getGraph()) && (q.getPredicate().equals(rv("titleControlHead"))
                || data.contains(CURRENT, q.getSubject(), rv("titleControlHead"), Node.ANY)
                || data.contains(CURRENT, q.getSubject(), rv("protectionHead"), Node.ANY)))
                protectedTitle = true;
            if (REVISIONS.equals(q.getGraph()) && q.getPredicate().equals(rv("controlField"))
                && ("title".equals(text(q.getObject())) || "title:en".equals(text(q.getObject())))) protectedTitle = true;
        }
        if (control == null && !protectedTitle) return null;
        if (control == null || !control.isURI()) return error("title control expectation and successor required");
        try {
            if (proof == null || !proof.isObject()) return error("trusted title admission required");
            JsonObject object = proof.getAsObject();
            String payload = ProfileRegistry.required(object, "payload"), signature = ProfileRegistry.required(object, "signature");
            Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
            if (!signature.matches("[0-9a-f]{64}") || !MessageDigest.isEqual(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)),
                HexFormat.of().parseHex(signature))) return error("title admission signature differs");
            var claims = JSON.parseAny(payload).getAsArray();
            String commandHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(update.getBytes(StandardCharsets.UTF_8)));
            if (claims.size() != 9 || !claims.get(0).getAsString().value().equals("rezics-work-title-admission-v1")
                || !claims.get(5).getAsString().value().equals(receipt) || !claims.get(6).getAsString().value().equals(digest)
                || !claims.get(7).getAsString().value().equals(commandHash)
                || !Instant.parse(claims.get(8).getAsString().value()).isAfter(Instant.now())) return error("title admission binding or deadline differs");
            String action = claims.get(2).getAsString().value(), scope = claims.get(3).getAsString().value();
            Node own = uri(receipt), work = template(modify.getInsertQuads(), RECEIPTS, own, rv("work"));
            Node head = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedHead"));
            Node expectedControl = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedControl"));
            Node expectedProtection = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedProtection"));
            Node expectedEpoch = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedControlEpoch"));
            if (work == null || !work.isURI() || head == null || !head.isURI() || expectedControl == null || expectedEpoch == null
                || expectedProtection == null || !expectedProtection.isURI()) return error("title expectations incomplete");
            String prefix = action.equals("work.edit") ? "work:edit:" : action.equals("work.title.apply") ? "work:title:apply:"
                : action.equals("work.title.return") ? "work:title:return:" : null;
            if (prefix == null || !scope.equals(prefix + work.getURI())) return error("title admission action or scope differs");
            for (int i : List.of(1, 2, 3, 4)) {
                String property = i == 1 ? "admissionId" : i == 2 ? "action" : i == 3 ? "admittedScope" : "authorityEpoch";
                Node value = template(modify.getInsertQuads(), RECEIPTS, own, rv(property));
                if (value == null || !value.isLiteral() || !value.getLiteralLexicalForm().equals(claims.get(i).getAsString().value()))
                    return error("title receipt admission differs");
            }
            Node old = one(data, CURRENT, work, rv("titleControlHead"));
            Node protection = one(data, CURRENT, work, rv("protectionHead"));
            BigInteger epoch = old == null ? BigInteger.ZERO : integer(one(data, REVISIONS, old, rv("controlEpoch")));
            if (epoch == null || !epoch.equals(integer(expectedEpoch)) || !(old == null ? rv("Absent").equals(expectedControl) : old.equals(expectedControl))
                || !(protection == null ? rv("Absent").equals(expectedProtection) : protection.equals(expectedProtection))
                || protection != null && !rv("Open").equals(one(data, REVISIONS, protection, rv("protectionMode")))
                || !head.equals(one(data, CURRENT, work, rv("head")))) return error("title transaction basis changed");
            Node json = template(modify.getInsertQuads(), REVISIONS, control, rv("controlIntent"));
            if (json == null || !json.isLiteral()) return error("title control intent missing");
            JsonObject intent = JSON.parse(json.getLiteralLexicalForm());
            JsonObject basis = intent.get("basis").getAsObject();
            if (!ProfileRegistry.required(intent, "work").equals(work.getURI())
                || !ProfileRegistry.required(intent, "expectedHead").equals(head.getURI())
                || !ProfileRegistry.required(intent, "action").equals(action)
                || !ProfileRegistry.required(basis, "epoch").equals(epoch.toString())
                || !(protection == null ? basis.get("protection").isNull()
                    : ProfileRegistry.required(basis, "protection").equals(protection.getURI()))
                || (old == null ? !basis.get("head").isNull() : !ProfileRegistry.required(basis, "head").equals(old.getURI())))
                return error("title immutable intent differs from transaction basis");
            if (data.contains(REVISIONS, control, Node.ANY, Node.ANY)) return error("control successor is not fresh");
            Node next = template(modify.getInsertQuads(), RECEIPTS, own, rv("workRevision"));
            if (next == null || !next.isURI() || !plan.current().equals(Set.of(work.getURI()))
                || !plan.revisions().equals(action.equals("work.title.return") ? Set.of(control.getURI()) : Set.of(control.getURI(), next.getURI())))
                return error("title footprint differs");
            for (Quad q : all) if (CURRENT.equals(q.getGraph()) && !(q.getPredicate().equals(rv("titleControlHead"))
                || !action.equals("work.title.return") && (q.getPredicate().equals(rv("head")) || q.getPredicate().equals(LABEL))))
                return error("unrelated Work mutation in title command");
            if (action.equals("work.edit")) {
                if (!intent.get("source").isNull()) return error("human edit cannot claim source origin");
            } else {
                JsonObject source = intent.get("source").getAsObject();
                Node record = uri(ProfileRegistry.required(source, "record")), observation = uri(ProfileRegistry.required(source, "observation")),
                    conversion = uri(ProfileRegistry.required(source, "conversion"));
                if (!record.equals(one(data, SOURCE, observation, rv("sourceRecord")))
                    || !observation.equals(one(data, SOURCE, conversion, rv("sourceObservation")))
                    || !ProfileRegistry.required(source, "mapping").equals(text(one(data, SOURCE, conversion, rv("sourceMappingRevision")))))
                    return error("source observation or mapping differs");
                if (action.equals("work.title.apply")) {
                    if (!ProfileRegistry.required(intent, "title").equals(text(one(data, SOURCE, conversion, rv("sourceTitle")))))
                        return error("source title differs from retained conversion");
                    if (old == null) {
                        if (!ProfileRegistry.required(source, "initialHead").equals(head.getURI())
                            || data.contains(REVISIONS, head, rv("predecessor"), Node.ANY)) return error("unestablished source control requires original adoption head");
                    } else {
                        if (!rv("SourceManaged").equals(one(data, REVISIONS, old, rv("controlMode")))) return error("source cannot replace human control");
                        JsonObject prior = JSON.parse(text(one(data, REVISIONS, old, rv("controlIntent")))).get("source").getAsObject();
                        for (String field : List.of("binding", "record", "initialHead"))
                            if (!ProfileRegistry.required(prior, field).equals(ProfileRegistry.required(source, field))) return error("source control binding changed");
                    }
                } else if (old == null) return error("return requires an established control head");
            }
            String language = intent.hasKey("language") ? ProfileRegistry.required(intent, "language")
                : one(data, CURRENT, work, LABEL).getLiteralLanguage();
            if (language.isEmpty()) language = "und";
            if (!validLanguage(language)) return error("invalid title language");
            Node field = template(modify.getInsertQuads(), REVISIONS, control, rv("controlField"));
            Node declared = template(modify.getInsertQuads(), REVISIONS, control, rv("controlLanguage"));
            if (!("title".equals(text(field)) && language.equalsIgnoreCase(text(declared))
                || "title:en".equals(text(field)) && language.equalsIgnoreCase("en") && declared == null))
                return error("title control language differs from intent");
            return new Snapshot(work, head, control, old, epoch, action, intent, language, null);
        } catch (Exception ex) { return error("invalid title admission or control basis"); }
    }

    static String check(DatasetGraph data, String receipt, Snapshot snapshot) {
        if (snapshot == null) return null;
        if (snapshot.error() != null) return snapshot.error();
        Node own = uri(receipt), control = snapshot.control(), work = snapshot.work();
        Node revision = one(data, RECEIPTS, own, rv("workRevision"));
        if (!control.equals(one(data, CURRENT, work, rv("titleControlHead")))
            || !work.equals(one(data, REVISIONS, control, rv("component")))
            || !revision.equals(one(data, CURRENT, work, rv("head")))
            || !revision.equals(one(data, REVISIONS, control, rv("workRevision")))
            || !snapshot.epoch().add(BigInteger.ONE).equals(integer(one(data, REVISIONS, control, rv("controlEpoch"))))
            || !(snapshot.oldControl() == null ? !data.contains(REVISIONS, control, rv("predecessor"), Node.ANY)
                : snapshot.oldControl().equals(one(data, REVISIONS, control, rv("predecessor"))))) return "title control successor differs";
        Node mode = rv(snapshot.action().equals("work.edit") ? "HumanControlled" : "SourceManaged");
        if (!mode.equals(one(data, REVISIONS, control, rv("controlMode"))) || !data.contains(REVISIONS, control, RDF.type.asNode(), rv("EditorialControlRevision")))
            return "title control mode differs from trusted origin";
        if (snapshot.action().equals("work.title.return") && !revision.equals(snapshot.before())) return "return changed content";
        if (!snapshot.action().equals("work.title.return") && revision.equals(snapshot.before())) return "edit requires a successor even for equal bytes";
        Node title = one(data, CURRENT, work, LABEL);
        if (title == null || !title.isLiteral() || !title.getLiteralLanguage().equalsIgnoreCase(snapshot.language())
            || !title.getLiteralLexicalForm().equals(ProfileRegistry.required(snapshot.intent(), "title"))) return "title value differs from intent";
        return null;
    }

    static boolean validLanguage(String value) {
        if (value == null || value.length() > 35 || !value.matches("[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*")) return false;
        try { new java.util.Locale.Builder().setLanguageTag(value).build(); return true; }
        catch (java.util.IllformedLocaleException ex) { return false; }
    }

    private static Node template(List<Quad> quads, Node graph, Node subject, Node predicate) {
        Node result = null;
        for (Quad q : quads) if (q.getGraph().equals(graph) && q.getSubject().equals(subject) && q.getPredicate().equals(predicate)) {
            if (result != null) return null; result = q.getObject();
        }
        return result;
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var values = data.find(graph, subject, predicate, Node.ANY);
        try { if (!values.hasNext()) return null; Node value = values.next().getObject(); return values.hasNext() ? null : value; }
        finally { org.apache.jena.atlas.iterator.Iter.close(values); }
    }
    private static String text(Node value) { return value != null && value.isLiteral() ? value.getLiteralLexicalForm() : null; }
    private static BigInteger integer(Node value) { try { return new BigInteger(text(value)); } catch (RuntimeException ex) { return null; } }

    private static final String CANDIDATE_DOMAIN = "rezics-human-title-candidate-admission-v1";
    private static final String WORK_PROFILE = "https://rezics.com/definition/work-metadata-v1";
    private static final String TITLE_PROFILE = "https://rezics.com/definition/work-title-control-v2";
    private static final Node RETAINED_CANDIDATE = rv("retainedTitleCandidate");

    /** The enclosing serialized writer owns commit, cancellation and effect capture.
     * Proof actor fields are authenticated by the SQL issuer, never inferred from RDF. */
    static Map<String, Object> retainCandidate(DatasetGraph data, String receipt, String digest,
        JsonValue candidateJSON, JsonValue proof, byte[] key, long deadline) {
        try {
            TemplateIndexService.workScopeBudget(deadline);
            if (!data.isInTransaction() || data.transactionMode() != org.apache.jena.query.ReadWrite.WRITE)
                throw new IllegalArgumentException("title acceptance requires the native writer");
            DatasetGraph base = data;
            while (base instanceof org.apache.jena.sparql.core.DatasetGraphWrapper wrapper
                && !(base instanceof org.apache.jena.query.text.DatasetGraphText)) base = wrapper.getWrapped();
            if (base instanceof org.apache.jena.query.text.DatasetGraphText text
                && text.getTextIndex().getDocDef().getField(RETAINED_CANDIDATE) != null)
                throw new IllegalArgumentException("private title candidate predicate must remain unmapped");
            JsonObject candidate = closed(candidateJSON, "frame", "custodySha256", "mode");
            String frameBytes = string(candidate, "frame"), custody = string(candidate, "custodySha256"), mode = string(candidate, "mode");
            if (!Set.of("accept", "lookup").contains(mode) || !hex(custody)
                || frameBytes.length() > 32768 || frameBytes.getBytes(StandardCharsets.UTF_8).length > 32768)
                throw new IllegalArgumentException("invalid title candidate envelope");
            candidateJSONDepth(frameBytes);
            JsonObject frame = closed(JSON.parseAny(frameBytes), "format", "receipt", "digest", "admission", "actor", "intent",
                "planned", "originalManifest", "workManifest", "controlManifest", "mainVersion", "dataEpoch", "routingEpoch", "deadlineMs", "validations");
            validateCandidateFrame(frame, receipt, digest);
            if (!frameBytes.equals(canonicalCandidateJSON(frame))) throw new IllegalArgumentException("title frame is not canonical JSON");
            JsonObject signature = closed(proof, "payload", "signature");
            String payload = string(signature, "payload"), signed = string(signature, "signature"), frameHash = sha256(frameBytes);
            if (payload.length() > 8192 || !hex(signed)) throw new IllegalArgumentException("invalid title candidate proof");
            candidateJSONDepth(payload);
            Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
            if (!MessageDigest.isEqual(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)), HexFormat.of().parseHex(signed)))
                throw new IllegalArgumentException("title candidate signature differs");
            JsonObject admission = frame.get("admission").getAsObject(), actor = frame.get("actor").getAsObject();
            var claims = JSON.parseAny(payload).getAsArray();
            if (claims.size() != 12) throw new IllegalArgumentException("title candidate proof domain differs");
            var expected = new org.apache.jena.atlas.json.JsonArray();
            expected.add(CANDIDATE_DOMAIN); expected.add(string(admission, "id")); expected.add("work.edit");
            expected.add(string(admission, "scope")); expected.add(string(admission, "authorityEpoch")); expected.add(receipt);
            expected.add(digest); expected.add(frameHash); expected.add(custody); expected.add(string(actor, "principalId"));
            expected.add(actor.get("actingSubject")); expected.add(string(admission, "expiresAt"));
            if (!canonicalCandidateJSON(claims).equals(canonicalCandidateJSON(expected)))
                throw new IllegalArgumentException("title candidate actor, custody or frame binding differs");
            Instant expiry = Instant.parse(string(admission, "expiresAt"));
            Node subject = uri("urn:rezics:title-candidate:" + sha256(receipt));
            Node retained = candidateOne(data, PublicNameProjection.REPAIR, subject, RETAINED_CANDIDATE);
            JsonObject record = null;
            if (retained != null) {
                if (!retained.isLiteral() || retained.getLiteralLexicalForm().length() > 98304)
                    throw new IllegalArgumentException("retained title candidate is malformed");
                candidateJSONDepth(retained.getLiteralLexicalForm());
                record = closed(JSON.parseAny(retained.getLiteralLexicalForm()), "format", "frame", "proof", "frameSha256", "custodySha256", "captured");
                JsonObject retainedBasis = closed(record.get("captured"), "source", "adoption", "qualification", "dataEpoch", "routingEpoch", "store");
                for (String field : retainedBasis.keys()) scalarIdentity(string(retainedBasis, field));
                if (!"rezics-human-title-candidate-record-v1".equals(string(record, "format"))
                    || !frameBytes.equals(string(record, "frame")) || !frameHash.equals(string(record, "frameSha256"))
                    || !custody.equals(string(record, "custodySha256"))
                    || !canonicalCandidateJSON(signature).equals(canonicalCandidateJSON(record.get("proof"))))
                    throw new IllegalArgumentException("same receipt has a different retained title candidate");
            }
            // Authentication and exact retained comparison precede terminal replay.
            Node outcome = candidateOne(data, RECEIPTS, uri(receipt), rv("outcome"));
            if (outcome != null) {
                if (record == null || !Set.of(rv("Succeeded"), rv("Cancelled")).contains(outcome)
                    || !digest.equals(text(candidateOne(data, RECEIPTS, uri(receipt), rv("requestDigest")))))
                    throw new IllegalArgumentException("original title receipt differs");
                TemplateIndexService.workScopeBudget(deadline);
                return Map.of("status", "terminal", "receipt", receipt, "digest", digest,
                    "outcome", outcome.equals(rv("Succeeded")) ? "succeeded" : "cancelled", "changed", false);
            }
            if (mode.equals("lookup")) {
                if (record == null) throw new IllegalArgumentException("historical lookup requires exact retained acceptance");
                TemplateIndexService.workScopeBudget(deadline);
                return candidateResult("historical", receipt, digest, retained.getLiteralLexicalForm(), false);
            }
            if (!expiry.isAfter(Instant.now())) throw new IllegalArgumentException("fresh title admission expired");
            verifyCurrentTitleBasis(data, frame);
            var captured = PublicNameProjection.captureWorkNameBasis(data, uri(string(frame.get("intent").getAsObject(), "work")), deadline);
            JsonObject current = capturedJSON(captured);
            if (!string(frame, "dataEpoch").equals(captured.dataEpoch()) || !string(frame, "routingEpoch").equals(captured.routingEpoch()))
                throw new IllegalArgumentException("title frame lineage differs");
            if (record != null) {
                if (!canonicalCandidateJSON(current).equals(canonicalCandidateJSON(record.get("captured"))))
                    throw new IllegalArgumentException("retained title candidate source or adoption basis changed");
                TemplateIndexService.workScopeBudget(deadline);
                return candidateResult("accepted", receipt, digest, retained.getLiteralLexicalForm(), false);
            }
            record = new JsonObject(); record.put("format", "rezics-human-title-candidate-record-v1");
            record.put("frame", frameBytes); record.put("proof", signature); record.put("frameSha256", frameHash);
            record.put("custodySha256", custody); record.put("captured", current);
            String bytes = canonicalCandidateJSON(record);
            TemplateIndexService.workScopeBudget(deadline);
            data.add(PublicNameProjection.REPAIR, subject, RETAINED_CANDIDATE, NodeFactory.createLiteralString(bytes));
            TemplateIndexService.workScopeBudget(deadline);
            return candidateResult("accepted", receipt, digest, bytes, true);
        } catch (java.util.concurrent.CancellationException cancelled) {
            return Map.of("status", "deadline", "changed", false);
        } catch (Exception invalid) {
            return Map.of("status", "conflict", "reason", "invalid or stale retained title candidate", "changed", false);
        }
    }
    private static Map<String, Object> candidateResult(String status, String receipt, String digest, String record, boolean changed) {
        return Map.of("status", status, "receipt", receipt, "digest", digest, "record", record, "changed", changed);
    }
    private static JsonObject capturedJSON(PublicNameProjection.WorkNameBasis basis) {
        JsonObject result = new JsonObject(); result.put("source", basis.source()); result.put("adoption", basis.adoption());
        result.put("qualification", basis.qualification()); result.put("dataEpoch", basis.dataEpoch());
        result.put("routingEpoch", basis.routingEpoch()); result.put("store", basis.store()); return result;
    }
    private static void validateCandidateFrame(JsonObject frame, String receipt, String digest) throws Exception {
        if (!"rezics-human-title-candidate-frame-v1".equals(string(frame, "format"))
            || !receipt.equals(string(frame, "receipt")) || !hex(digest) || !digest.equals(string(frame, "digest"))
            || !new java.math.BigDecimal(frame.get("deadlineMs").getAsNumber().value().toString()).equals(new java.math.BigDecimal("10000")))
            throw new IllegalArgumentException("title frame identity differs");
        JsonObject admission = closed(frame.get("admission"), "id", "action", "scope", "authorityEpoch", "expiresAt"),
            actor = closed(frame.get("actor"), "principalId", "actingSubject"),
            intent = closed(frame.get("intent"), "work", "expectedHead", "basis", "action", "title", "language", "source"),
            basis = closed(intent.get("basis"), "head", "epoch", "protection"),
            planned = closed(frame.get("planned"), "revision", "control", "operation");
        String work = product(intent, "work"), head = product(intent, "expectedHead"), main = product(frame, "mainVersion"),
            epoch = string(basis, "epoch"), language = string(intent, "language"), title = string(intent, "title");
        nullableProduct(basis.get("head")); nullableProduct(basis.get("protection"));
        if (!epoch.matches("0|[1-9][0-9]{0,18}") || basis.get("head").isNull() != epoch.equals("0")
            || !"work.edit".equals(string(intent, "action")) || !intent.get("source").isNull()
            || !"work.edit".equals(string(admission, "action")) || !("work:edit:" + work).equals(string(admission, "scope"))
            || !string(admission, "authorityEpoch").matches("0|[1-9][0-9]{0,18}")
            || !string(admission, "id").matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
            || !receipt.equals("urn:rezics:receipt:" + sha256(string(admission, "id") + "\0edit-metadata-work"))
            || title.isEmpty() || title.length() > 200 || title.chars().anyMatch(c -> c < 32 || c == 127)
            || !validLanguage(language) || !new java.util.Locale.Builder().setLanguageTag(language).build().toLanguageTag().equals(language))
            throw new IllegalArgumentException("title intent differs from the admitted human v2 operation");
        if (!string(actor, "principalId").matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
            throw new IllegalArgumentException("title principal differs from SQL UUID identity");
        nullableProduct(actor.get("actingSubject"));
        String expiresAt = string(admission, "expiresAt");
        if (!expiresAt.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")
            || !new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(expiresAt)).equals(expiresAt))
            throw new IllegalArgumentException("title expiry is not canonical UTC milliseconds");
        Set<String> identities = new java.util.HashSet<>(List.of(work, head, main));
        if (!basis.get("head").isNull()) identities.add(basis.get("head").getAsString().value());
        if (!basis.get("protection").isNull()) identities.add(basis.get("protection").getAsString().value());
        for (String role : List.of("revision", "control", "operation"))
            if (!identities.add(product(planned, role))) throw new IllegalArgumentException("planned title identities are not distinct");
        for (String role : List.of("originalManifest", "workManifest", "controlManifest"))
            if (!string(frame, role).matches("urn:rezics:sha256:[0-9a-f]{64}")) throw new IllegalArgumentException("invalid title manifest");
        scalarIdentity(string(frame, "dataEpoch")); scalarIdentity(string(frame, "routingEpoch"));
        if (string(frame, "dataEpoch").length() > 128 || string(frame, "routingEpoch").length() > 128)
            throw new IllegalArgumentException("title frame lineage exceeds its bound");
        String intentDigest = "{\"profile\":\"work-title-control-v2\",\"work\":" + quote(work)
            + ",\"expectedHead\":" + quote(head) + ",\"basis\":{\"head\":" + canonicalCandidateJSON(basis.get("head"))
            + ",\"epoch\":" + quote(epoch) + ",\"protection\":" + canonicalCandidateJSON(basis.get("protection"))
            + "},\"action\":\"work.edit\",\"title\":" + quote(title) + ",\"language\":" + quote(language) + ",\"source\":null}";
        if (!digest.equals(sha256(intentDigest))) throw new IllegalArgumentException("title intent digest differs");
        var validations = frame.get("validations").getAsArray();
        if (validations.size() != 3) throw new IllegalArgumentException("title validations differ");
        String[] profiles = { "work-metadata-v1", "work-metadata-v1", "work-title-control-v2" };
        String[] shapes = { WORK_PROFILE + "/work-shape", WORK_PROFILE + "/main-version-shape", TITLE_PROFILE + "/control-shape" };
        String[] foci = { work, main, string(planned, "control") };
        for (int i = 0; i < 3; i++) {
            JsonObject validation = closed(validations.get(i), "profile", "sha256", "shape", "focus", "graphs", "binding");
            if (!profiles[i].equals(string(validation, "profile")) || !shapes[i].equals(string(validation, "shape"))
                || !hex(string(validation, "sha256")) || !closed(validation.get("binding")).keys().isEmpty()
                || validation.get("focus").getAsArray().size() != 1
                || !foci[i].equals(validation.get("focus").getAsArray().get(0).getAsString().value()))
                throw new IllegalArgumentException("title validation target differs");
            var graphs = validation.get("graphs").getAsArray();
            if (graphs.size() != (i == 2 ? 2 : 1) || !CommandPolicy.CURRENT.equals(graphs.get(0).getAsString().value())
                || i == 2 && !CommandPolicy.REVISIONS.equals(graphs.get(1).getAsString().value()))
                throw new IllegalArgumentException("title validation graphs differ");
        }
    }
    private static void verifyCurrentTitleBasis(DatasetGraph data, JsonObject frame) {
        JsonObject intent = frame.get("intent").getAsObject(), basis = intent.get("basis").getAsObject();
        Node work = uri(string(intent, "work")), head = uri(string(intent, "expectedHead")), main = uri(string(frame, "mainVersion"));
        Node control = candidateOne(data, CURRENT, work, rv("titleControlHead")), protection = candidateOne(data, CURRENT, work, rv("protectionHead"));
        if (!data.contains(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))
            || !head.equals(candidateOne(data, CURRENT, work, rv("head")))
            || !main.equals(candidateOne(data, CURRENT, work, rv("mainVersion")))
            || !data.contains(CURRENT, main, RDF.type.asNode(), rv("MainVersion"))
            || !work.equals(candidateOne(data, CURRENT, main, rv("work")))
            || !data.contains(REVISIONS, head, RDF.type.asNode(), rv("RevisionAnchor"))
            || data.contains(REVISIONS, head, RDF.type.asNode(), rv("ErasedRevision"))
            || !work.equals(candidateOne(data, REVISIONS, head, rv("component")))
            || !uri(string(frame, "originalManifest")).equals(candidateOne(data, REVISIONS, head, rv("manifest")))
            || !uri(WORK_PROFILE).equals(candidateOne(data, REVISIONS, head, rv("modelRevision")))
            || !uri(WORK_PROFILE).equals(candidateOne(data, REVISIONS, head, rv("shapeRevision")))
            || !Objects.equals(control, basis.get("head").isNull() ? null : uri(basis.get("head").getAsString().value()))
            || !Objects.equals(protection, basis.get("protection").isNull() ? null : uri(basis.get("protection").getAsString().value())))
            throw new IllegalArgumentException("current title basis changed");
        if (control != null && (!data.contains(REVISIONS, control, RDF.type.asNode(), rv("EditorialControlRevision"))
            || data.contains(REVISIONS, control, RDF.type.asNode(), rv("ErasedRevision"))
            || !work.equals(candidateOne(data, REVISIONS, control, rv("component")))
            || !new BigInteger(string(basis, "epoch")).equals(integer(candidateOne(data, REVISIONS, control, rv("controlEpoch"))))))
            throw new IllegalArgumentException("current title control is unavailable");
        if (protection != null && (!data.contains(REVISIONS, protection, RDF.type.asNode(), rv("ProtectionRevision"))
            || data.contains(REVISIONS, protection, RDF.type.asNode(), rv("ErasedRevision"))
            || !work.equals(candidateOne(data, REVISIONS, protection, rv("component")))
            || !rv("Open").equals(candidateOne(data, REVISIONS, protection, rv("protectionMode")))))
            throw new IllegalArgumentException("protected title requires its reviewed owner path");
        for (String role : List.of("revision", "control", "operation")) {
            Node planned = uri(string(frame.get("planned").getAsObject(), role));
            if (data.contains(Node.ANY, planned, Node.ANY, Node.ANY)) throw new IllegalArgumentException("planned title identity already exists");
        }
    }
    private static Node candidateOne(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var rows = data.find(graph, subject, predicate, Node.ANY);
        try {
            Node value = rows.hasNext() ? rows.next().getObject() : null;
            if (rows.hasNext()) throw new IllegalArgumentException("title basis is ambiguous"); return value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static JsonObject closed(JsonValue value, String... fields) {
        if (value == null || !value.isObject() || !value.getAsObject().keys().equals(Set.of(fields)))
            throw new IllegalArgumentException("unknown or missing title frame field");
        return value.getAsObject();
    }
    private static String string(JsonObject value, String field) { return value.get(field).getAsString().value(); }
    private static void scalarIdentity(String value) {
        if (value.isEmpty() || value.length() > 2048 || value.chars().anyMatch(c -> c < 32 || c == 127))
            throw new IllegalArgumentException("invalid title identity");
    }
    private static String product(JsonObject value, String field) {
        String result = string(value, field);
        if (!result.matches("https://rezics.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
            throw new IllegalArgumentException("invalid native title identity"); return result;
    }
    private static void nullableProduct(JsonValue value) {
        if (!value.isNull()) {
            var object = new JsonObject(); object.put("id", value); product(object, "id");
        }
    }
    private static boolean hex(String value) { return value != null && value.matches("[0-9a-f]{64}"); }
    private static String sha256(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
    static void candidateJSONDepth(String bytes) { jsonDepth(bytes, 8); }
    static void commandJSONDepth(String bytes) { jsonDepth(bytes, 32); }
    private static void jsonDepth(String bytes, int maximum) {
        int depth = 0; boolean quoted = false, escaped = false;
        for (int i = 0; i < bytes.length(); i++) {
            char value = bytes.charAt(i);
            if (quoted) {
                if (escaped) escaped = false;
                else if (value == '\\') escaped = true;
                else if (value == '"') quoted = false;
            } else if (value == '"') quoted = true;
            else if (value == '{' || value == '[') {
                if (++depth > maximum) throw new IllegalArgumentException("title candidate JSON nesting differs");
            } else if (value == '}' || value == ']') depth--;
        }
    }
    /** Same sorted-object, compact JSON bytes as the existing custody canonicalizer. */
    static String canonicalCandidateJSON(JsonValue value) {
        if (value.isObject()) return value.getAsObject().keys().stream().sorted()
            .map(key -> quote(key) + ":" + canonicalCandidateJSON(value.getAsObject().get(key)))
            .collect(java.util.stream.Collectors.joining(",", "{", "}"));
        if (value.isArray()) {
            List<String> elements = new ArrayList<>(); value.getAsArray().forEach(element -> elements.add(canonicalCandidateJSON(element)));
            return String.join(",", elements).transform(elementsJSON -> "[" + elementsJSON + "]");
        }
        if (value.isString()) return quote(value.getAsString().value());
        return value.toString();
    }
    private static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> result.append("\\\""); case '\\' -> result.append("\\\\");
                case '\b' -> result.append("\\b"); case '\f' -> result.append("\\f");
                case '\n' -> result.append("\\n"); case '\r' -> result.append("\\r"); case '\t' -> result.append("\\t");
                default -> {
                    if (c < 32 || Character.isSurrogate(c) && !(Character.isHighSurrogate(c) && i + 1 < value.length()
                        && Character.isLowSurrogate(value.charAt(i + 1)) || Character.isLowSurrogate(c) && i > 0 && Character.isHighSurrogate(value.charAt(i - 1))))
                        result.append(String.format("\\u%04x", (int) c));
                    else result.append(c);
                }
            }
        }
        return result.append('"').toString();
    }
    private TitleControlPolicy() {}
}
