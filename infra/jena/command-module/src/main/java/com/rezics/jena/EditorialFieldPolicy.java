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

/** A field-local native CAS. The title remains on the Work's original control path. */
final class EditorialFieldPolicy {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        RECEIPTS = uri(CommandPolicy.RECEIPTS), SOURCE = uri(CommandPolicy.SOURCE);
    private static final String PROFILE = "https://rezics.com/definition/work-editorial-field-v1";
    private static final String DEFINITION = "https://rezics.com/definition/work-synopsis-v1";
    private static final String CONTEXT = "urn:rezics:context:global-native";
    record Snapshot(Node slot, Node content, Node control, Node oldContent, Node oldControl,
                    BigInteger epoch, String value, String origin, String error) {}
    private static Snapshot error(String reason) {
        return new Snapshot(null, null, null, null, null, null, null, null, reason);
    }

    static Snapshot capture(DatasetGraph data, CommandPolicy.Plan plan, String receipt,
                            String digest, String update, JsonValue proof, byte[] key,
                            boolean protectedCommand) {
        if (protectedCommand || !(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        boolean touches = false;
        List<Quad> all = new ArrayList<>(modify.getInsertQuads()); all.addAll(modify.getDeleteQuads());
        for (Quad q : all) {
            if (CURRENT.equals(q.getGraph()) && (data.contains(CURRENT, q.getSubject(), RDF.type.asNode(), rv("EditorialFieldSlot"))
                || q.getPredicate().equals(rv("fieldControlHead"))
                || RDF.type.asNode().equals(q.getPredicate()) && rv("EditorialFieldSlot").equals(q.getObject()))) touches = true;
            if (REVISIONS.equals(q.getGraph()) && RDF.type.asNode().equals(q.getPredicate())
                && Set.of(rv("EditorialFieldRevision")).contains(q.getObject())) touches = true;
            if (REVISIONS.equals(q.getGraph()) && q.getPredicate().equals(rv("controlField"))
                && "synopsis".equals(text(q.getObject()))) touches = true;
            if (REVISIONS.equals(q.getGraph()) && (data.contains(REVISIONS, q.getSubject(),
                RDF.type.asNode(), rv("EditorialFieldRevision"))
                || data.contains(REVISIONS, q.getSubject(), RDF.type.asNode(), rv("EditorialFieldControlRevision"))))
                return error("old editorial field revision is immutable");
        }
        if (!touches) return null;
        try {
            Node own = uri(receipt);
            Node slot = template(modify.getInsertQuads(), RECEIPTS, own, rv("fieldSlot"));
            Node content = template(modify.getInsertQuads(), RECEIPTS, own, rv("fieldRevision"));
            Node control = template(modify.getInsertQuads(), RECEIPTS, own, rv("fieldControl"));
            Node work = template(modify.getInsertQuads(), RECEIPTS, own, rv("work"));
            Node head = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedHead"));
            Node expectedContent = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedContent"));
            Node expectedControl = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedControl"));
            Node expectedProtection = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedProtection"));
            Node expectedEpoch = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedControlEpoch"));
            if (slot == null || !slot.isURI() || content == null || !content.isURI() || control == null || !control.isURI()
                || work == null || !work.isURI() || head == null || !head.isURI() || expectedContent == null
                || expectedControl == null || expectedProtection == null || expectedEpoch == null)
                return error("field-control receipt or exact basis is incomplete");
            String identity = "[\"rezics-editorial-field-v1\",\"" + work.getURI()
                + "\",\"" + DEFINITION + "\",null,\"" + CONTEXT + "\"]";
            String computed = "urn:rezics:editorial-field:" + sha(identity);
            if (!slot.getURI().equals(computed) || !head.equals(one(data, CURRENT, work, rv("head")))
                || !head.equals(template(modify.getInsertQuads(), RECEIPTS, own, rv("workRevision")))
                || !plan.current().equals(Set.of(slot.getURI()))
                || !plan.revisions().equals(Set.of(content.getURI(), control.getURI()))
                || data.contains(REVISIONS, content, Node.ANY, Node.ANY)
                || data.contains(REVISIONS, control, Node.ANY, Node.ANY))
                return error("field-control target or successor footprint differs");
            Node workProtection = one(data, CURRENT, work, rv("protectionHead"));
            if (workProtection != null && !rv("Open").equals(one(data, REVISIONS,
                workProtection, rv("protectionMode"))))
                return error("protected Work does not admit a field edit");
            if (!admitted(modify, receipt, digest, update, proof, key, work))
                return error("trusted field-control admission required");
            Node oldContent = one(data, CURRENT, slot, rv("fieldHead"));
            Node oldControl = one(data, CURRENT, slot, rv("fieldControlHead"));
            Node oldProtection = one(data, CURRENT, slot, rv("protectionHead"));
            BigInteger epoch = oldControl == null ? BigInteger.ZERO
                : number(one(data, REVISIONS, oldControl, rv("controlEpoch")));
            if (epoch == null || !epoch.equals(number(expectedEpoch))
                || !(oldContent == null ? rv("Absent").equals(expectedContent) : oldContent.equals(expectedContent))
                || !(oldControl == null ? rv("Absent").equals(expectedControl) : oldControl.equals(expectedControl))
                || !(oldProtection == null ? rv("Absent").equals(expectedProtection) : oldProtection.equals(expectedProtection))
                || oldProtection != null && !rv("Open").equals(one(data, REVISIONS, oldProtection, rv("protectionMode")))
                || (oldContent == null) != (oldControl == null)
                || oldControl != null && !slot.equals(one(data, REVISIONS, oldControl, rv("component"))))
                return error("field-control content, control or protection basis changed");
            Node json = template(modify.getInsertQuads(), REVISIONS, control, rv("controlIntent"));
            if (json == null || !json.isLiteral()) return error("field-control intent missing");
            JsonObject intent = JSON.parse(json.getLiteralLexicalForm());
            JsonObject basis = intent.get("basis").getAsObject();
            String value = ProfileRegistry.required(intent, "value");
            String origin = ProfileRegistry.required(intent, "origin");
            if (!"work-editorial-field-control-v1".equals(ProfileRegistry.required(intent, "profile"))
                || !"synopsis".equals(ProfileRegistry.required(intent, "field"))
                || !work.getURI().equals(ProfileRegistry.required(intent, "work"))
                || !head.getURI().equals(ProfileRegistry.required(intent, "expectedWorkHead"))
                || !epoch.toString().equals(ProfileRegistry.required(basis, "epoch"))
                || !nullableMatches(basis, "head", oldControl)
                || !nullableMatches(basis, "contentHead", oldContent)
                || !nullableMatches(basis, "protection", oldProtection)
                || !value.equals(text(template(modify.getInsertQuads(), CURRENT, slot, rv("fieldValue"))))
                || !value.equals(text(template(modify.getInsertQuads(), REVISIONS, content, rv("fieldValue"))))
                || !Set.of("human", "source").contains(origin))
                return error("field-control immutable intent differs from its transaction basis");
            if (origin.equals("human") ? !intent.get("source").isNull()
                : !sourceMatches(data, intent.get("source").getAsObject(), value, oldControl, slot))
                return error("field-control source origin is not retained and eligible");
            if (!slot.equals(template(modify.getInsertQuads(), REVISIONS, content, rv("component")))
                || !slot.equals(template(modify.getInsertQuads(), REVISIONS, control, rv("component")))
                || !content.equals(template(modify.getInsertQuads(), REVISIONS, control, rv("fieldRevision")))
                || !uri(PROFILE).equals(template(modify.getInsertQuads(), REVISIONS, content, rv("modelRevision")))
                || !uri(PROFILE).equals(template(modify.getInsertQuads(), REVISIONS, control, rv("modelRevision"))))
                return error("field-control revision identity differs");
            for (Quad q : all) if (CURRENT.equals(q.getGraph()) && !Set.of(RDF.type.asNode(), rv("component"),
                rv("fieldDefinition"), rv("fieldValue"), rv("fieldHead"), rv("fieldControlHead"))
                .contains(q.getPredicate())) return error("unrelated field mutation");
            return new Snapshot(slot, content, control, oldContent, oldControl, epoch, value, origin, null);
        } catch (Exception ex) { return error("invalid field-control admission or basis"); }
    }

    static String check(DatasetGraph data, String receipt, Snapshot snapshot) {
        if (snapshot == null) return null;
        if (snapshot.error() != null) return snapshot.error();
        Node slot = snapshot.slot(), content = snapshot.content(), control = snapshot.control();
        if (!content.equals(one(data, CURRENT, slot, rv("fieldHead")))
            || !control.equals(one(data, CURRENT, slot, rv("fieldControlHead")))
            || !snapshot.value().equals(text(one(data, CURRENT, slot, rv("fieldValue"))))
            || !snapshot.value().equals(text(one(data, REVISIONS, content, rv("fieldValue"))))
            || !slot.equals(one(data, REVISIONS, content, rv("component")))
            || !slot.equals(one(data, REVISIONS, control, rv("component")))
            || !content.equals(one(data, REVISIONS, control, rv("fieldRevision")))
            || !(snapshot.oldContent() == null
                ? !data.contains(REVISIONS, content, rv("predecessor"), Node.ANY)
                : snapshot.oldContent().equals(one(data, REVISIONS, content, rv("predecessor"))))
            || !(snapshot.oldControl() == null
                ? !data.contains(REVISIONS, control, rv("predecessor"), Node.ANY)
                : snapshot.oldControl().equals(one(data, REVISIONS, control, rv("predecessor"))))
            || !snapshot.epoch().add(BigInteger.ONE).equals(number(one(data, REVISIONS, control, rv("controlEpoch"))))
            || !rv(snapshot.origin().equals("human") ? "HumanControlled" : "SourceManaged")
                .equals(one(data, REVISIONS, control, rv("controlMode")))
            || !rv("Undetermined").equals(one(data, REVISIONS, content, rv("rightsStatus"))))
            return "field-control successor differs";
        return null;
    }

    private static boolean sourceMatches(DatasetGraph data, JsonObject source, String value,
                                         Node oldControl, Node slot) {
        Node record = uri(ProfileRegistry.required(source, "record"));
        Node observation = uri(ProfileRegistry.required(source, "observation"));
        Node conversion = uri(ProfileRegistry.required(source, "conversion"));
        if (!"open-library-work-map-v1".equals(ProfileRegistry.required(source, "mapping"))
            || !record.equals(one(data, SOURCE, observation, rv("sourceRecord")))
            || !observation.equals(one(data, SOURCE, conversion, rv("sourceObservation")))
            || !"open-library-work-map-v1".equals(text(one(data, SOURCE, conversion, rv("sourceMappingRevision"))))
            || !value.equals(text(one(data, SOURCE, conversion, rv("sourceDescription"))))) return false;
        if (oldControl != null) {
            if (!rv("SourceManaged").equals(one(data, REVISIONS, oldControl, rv("controlMode")))) return false;
            JsonObject prior = JSON.parse(text(one(data, REVISIONS, oldControl, rv("controlIntent")))).get("source").getAsObject();
            return ProfileRegistry.required(prior, "record").equals(record.getURI());
        }
        return !data.contains(CURRENT, slot, rv("fieldHead"), Node.ANY);
    }

    static boolean admitted(UpdateModify modify, String receipt, String digest,
                                    String update, JsonValue proof, byte[] key, Node work) throws Exception {
        if (proof == null || !proof.isObject()) return false;
        JsonObject object = proof.getAsObject();
        String payload = ProfileRegistry.required(object, "payload");
        String signature = ProfileRegistry.required(object, "signature");
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
        if (!signature.matches("[0-9a-f]{64}") || !MessageDigest.isEqual(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)),
            HexFormat.of().parseHex(signature))) return false;
        var claims = JSON.parseAny(payload).getAsArray();
        if (claims.size() != 9 || !"rezics-work-title-admission-v1".equals(claims.get(0).getAsString().value())
            || !"work.edit".equals(claims.get(2).getAsString().value())
            || !("work:edit:" + work.getURI()).equals(claims.get(3).getAsString().value())
            || !receipt.equals(claims.get(5).getAsString().value())
            || !digest.equals(claims.get(6).getAsString().value())
            || !sha(update).equals(claims.get(7).getAsString().value())
            || !Instant.parse(claims.get(8).getAsString().value()).isAfter(Instant.now())) return false;
        for (int i : List.of(1, 2, 3, 4)) {
            String predicate = i == 1 ? "admissionId" : i == 2 ? "action" : i == 3 ? "admittedScope" : "authorityEpoch";
            if (!claims.get(i).getAsString().value().equals(text(template(modify.getInsertQuads(),
                RECEIPTS, uri(receipt), rv(predicate))))) return false;
        }
        return true;
    }

    private static boolean nullableMatches(JsonObject object, String key, Node value) {
        return value == null ? object.get(key).isNull() : value.getURI().equals(ProfileRegistry.required(object, key));
    }
    private static String sha(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(value.getBytes(StandardCharsets.UTF_8)));
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
    private static BigInteger number(Node value) { try { return new BigInteger(text(value)); } catch (RuntimeException ex) { return null; } }
    private EditorialFieldPolicy() {}
}
