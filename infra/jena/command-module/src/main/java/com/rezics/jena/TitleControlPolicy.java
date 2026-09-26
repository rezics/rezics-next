package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
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
                    String action, JsonObject intent, String error) {}
    private static Snapshot error(String reason) { return new Snapshot(null, null, null, null, null, null, null, reason); }

    static Snapshot capture(DatasetGraph data, CommandPolicy.Plan plan, String receipt,
                            String digest, String update, JsonValue proof, byte[] key) {
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
            if (REVISIONS.equals(q.getGraph()) && RDF.type.asNode().equals(q.getPredicate())
                && q.getObject().equals(rv("EditorialControlRevision"))) protectedTitle = true;
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
                || !rv("Absent").equals(expectedProtection)) return error("title expectations incomplete");
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
            BigInteger epoch = old == null ? BigInteger.ZERO : integer(one(data, REVISIONS, old, rv("controlEpoch")));
            if (epoch == null || !epoch.equals(integer(expectedEpoch)) || !(old == null ? rv("Absent").equals(expectedControl) : old.equals(expectedControl))
                || data.contains(CURRENT, work, rv("protectionHead"), Node.ANY)
                || !head.equals(one(data, CURRENT, work, rv("head")))) return error("title transaction basis changed");
            Node json = template(modify.getInsertQuads(), REVISIONS, control, rv("controlIntent"));
            if (json == null || !json.isLiteral()) return error("title control intent missing");
            JsonObject intent = JSON.parse(json.getLiteralLexicalForm());
            JsonObject basis = intent.get("basis").getAsObject();
            if (!ProfileRegistry.required(intent, "work").equals(work.getURI())
                || !ProfileRegistry.required(intent, "expectedHead").equals(head.getURI())
                || !ProfileRegistry.required(intent, "action").equals(action)
                || !ProfileRegistry.required(basis, "epoch").equals(epoch.toString())
                || !basis.get("protection").isNull()
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
            return new Snapshot(work, head, control, old, epoch, action, intent, null);
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
        if (title == null || !title.isLiteral() || !title.getLiteralLanguage().equals("en")
            || !title.getLiteralLexicalForm().equals(ProfileRegistry.required(snapshot.intent(), "title"))) return "title value differs from intent";
        return null;
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
    private TitleControlPolicy() {}
}
