package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.graph.Triple;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.sparql.syntax.ElementGroup;
import org.apache.jena.sparql.syntax.Element;
import org.apache.jena.sparql.syntax.ElementNamedGraph;
import org.apache.jena.sparql.syntax.ElementPathBlock;
import org.apache.jena.sparql.syntax.ElementService;
import org.apache.jena.sparql.syntax.ElementTriplesBlock;
import org.apache.jena.sparql.syntax.ElementUnion;
import org.apache.jena.sparql.syntax.ElementVisitorBase;
import org.apache.jena.sparql.syntax.ElementWalker;
import org.apache.jena.vocabulary.RDF;

/** Retained erasure replay inside the existing authenticated held writer.
 * The owner signs only after checking the independent journal while holding
 * its borrowed Access/relay transactions. This policy never releases either
 * hold, invents a stream position, advances the prior cursor or erases history.
 */
final class ErasureRestorePolicy {
    static final String PREFIX = "urn:rezics:receipt:erasure-restore:";
    static final String DOMAIN = "rezics-erasure-restore-v1";
    private static final String UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
    private static final String TARGET = "urn:rezics:content:revision:" + UUID;
    private static final int MAX_TARGETS = 64, MAX_UNITS = 64, MAX_QUADS = 16_384;
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), REVISIONS = uri(CommandPolicy.REVISIONS),
        RECEIPTS = uri(CommandPolicy.RECEIPTS), PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH), PRIVATE = uri(CommandPolicy.PRIVATE_SEARCH),
        PRODUCT = uri("urn:rezics:dataset:product");
    private static final Set<Node> REFERENCES = Set.of(rv("revision"), rv("contentRevision"));
    record Key(Node graph, Node subject) {}
    record Snapshot(CommandInvariant.Control control, Map<Key, Set<Quad>> controls,
                    Map<Key, Set<Quad>> expected, Set<Key> units, boolean replayed, String error) {}
    private record Claims(String dataEpoch, String routingEpoch, String marker, String accessGeneration,
                          String erasureId, String epoch, List<String> targets, String originalEpoch,
                          String originalSequence, String originalDigest, String priorEpoch, String priorSequence) {}
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String value) { return uri("https://rezics.com/vocab/" + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node integer(String value) { return NodeFactory.createLiteralByValue(new BigInteger(value), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    private static Snapshot failure(String reason) { return new Snapshot(null, Map.of(), Map.of(), Set.of(), false, reason); }
    static boolean applies(String receipt) { return receipt.startsWith(PREFIX); }

    /** Called by the parser before granting this family's private-search exception. */
    static void validateTemplate(CommandPolicy.Plan plan, String receipt) {
        if (!receipt.matches(PREFIX + "[0-9a-f]{64}") || plan.bootstrap() || plan.rebuild()
            || !plan.current().isEmpty() || !plan.source().isEmpty()
            || plan.revisions().isEmpty() || plan.revisions().size() > MAX_TARGETS
            || !plan.graphs().containsAll(Set.of(CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS))
            || !Set.of(CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS, CommandPolicy.PUBLIC_SEARCH, CommandPolicy.PRIVATE_SEARCH).containsAll(plan.graphs())
            || !(plan.request().getOperations().size() == 1 && plan.request().getOperations().getFirst() instanceof UpdateModify))
            throw new IllegalArgumentException("held erasure template footprint differs");
        var modify = (UpdateModify) plan.request().getOperations().getFirst();
        if (modify.getWithIRI() != null || !modify.getUsing().isEmpty() || !modify.getUsingNamed().isEmpty())
            throw new IllegalArgumentException("held erasure WITH/USING is unavailable");
        ElementWalker.walk(modify.getWherePattern(), new ElementVisitorBase() {
            @Override public void visit(ElementService service) { throw new IllegalArgumentException("held erasure SERVICE is unavailable"); }
        });
        Set<Key> units = new HashSet<>();
        Set<String> graphs = new HashSet<>(), targets = new HashSet<>();
        for (Quad quad : modify.getDeleteQuads()) {
            if (!Set.of(PUBLIC, PRIVATE).contains(quad.getGraph()) || !quad.getSubject().isURI()
                || !quad.getSubject().getURI().matches("urn:rezics:[a-z0-9:-]+")
                || !quad.getPredicate().isVariable() || !quad.getObject().isVariable())
                throw new IllegalArgumentException("held erasure deletes only complete concrete indexed units");
            units.add(new Key(quad.getGraph(), quad.getSubject())); graphs.add(quad.getGraph().getURI());
        }
        if (units.size() > MAX_UNITS || units.size() != modify.getDeleteQuads().size())
            throw new IllegalArgumentException("held erasure indexed unit bound differs");
        for (Quad quad : modify.getInsertQuads()) {
            if (!Set.of(REVISIONS, RECEIPTS).contains(quad.getGraph()) || !quad.getSubject().isURI()
                || !quad.getPredicate().isURI() || !(quad.getObject().isURI() || quad.getObject().isLiteral()))
                throw new IllegalArgumentException("held erasure insert values must be concrete");
            graphs.add(quad.getGraph().getURI());
            if (REVISIONS.equals(quad.getGraph())) {
                if (!quad.getSubject().getURI().matches(TARGET)
                    || !(quad.getPredicate().equals(RDF.type.asNode()) && quad.getObject().equals(rv("ErasedRevision"))
                        || quad.getPredicate().equals(rv("erasureEpoch")) && positiveEpoch(quad.getObject())))
                    throw new IllegalArgumentException("held erasure inserts only exact tombstones");
                targets.add(quad.getSubject().getURI());
            } else if (!quad.getSubject().equals(uri(receipt))
                && !quad.getSubject().getURI().matches("urn:rezics:receipt:erasure-graph:[0-9a-f]{64}"))
                throw new IllegalArgumentException("held erasure receipt subject differs");
        }
        if (!targets.equals(plan.revisions()) || !graphs.equals(plan.graphs())
            || new HashSet<>(modify.getInsertQuads()).size() != modify.getInsertQuads().size())
            throw new IllegalArgumentException("held erasure plan is ambiguous");
        boundedWhere(modify);
    }

    /** Used before the generic existing-receipt fast path, within the writer transaction. */
    static Snapshot capture(DatasetGraph data, CommandPolicy.Plan plan, String receipt, String digest,
                            String update, JsonValue proof, byte[] key) {
        try {
            validateTemplate(plan, receipt);
            Claims claims = admitted(receipt, digest, update, proof, key);
            var control = CommandInvariant.readControl(data);
            if (control == null || !control.held() || control.sequence().signum() != 0 || control.marker() == null
                || !control.epoch().equals(text(claims.dataEpoch())) || !control.routing().equals(text(claims.routingEpoch()))
                || !control.marker().equals(uri(claims.marker())) || !text(claims.priorEpoch()).equals(control.priorEpoch())
                || !new BigInteger(claims.priorSequence()).equals(control.priorSequence())
                || !data.contains(CONTROL, control.marker(), RDF.type.asNode(), rv("RestoreCutover"))
                || !data.contains(CONTROL, control.marker(), rv("dataEpoch"), control.epoch()))
                return failure("held erasure restore lineage differs");
            Set<Quad> productControl = stored(data, new Key(CONTROL, PRODUCT));
            Set<Quad> markerControl = stored(data, new Key(CONTROL, control.marker()));
            if (productControl.stream().filter(q -> q.getPredicate().equals(rv("restoreHold"))).count() != 1
                || markerControl.stream().filter(q -> q.getPredicate().equals(rv("reconciledPriorSequence"))).count() > 1
                || markerControl.stream().anyMatch(q -> q.getPredicate().equals(rv("reconciledPriorSequence")))
                    && (control.cursor() == null || control.cursor().signum() < 0))
                return failure("held erasure restore hold or cursor is ambiguous");
            var modify = (UpdateModify) plan.request().getOperations().getFirst();
            Set<Triple> guards = guards(modify);
            if (!guards.containsAll(Set.of(Triple.create(PRODUCT, rv("dataEpoch"), control.epoch()),
                Triple.create(PRODUCT, rv("routingEpoch"), control.routing()), Triple.create(PRODUCT, rv("sequence"), integer("0")),
                Triple.create(PRODUCT, rv("restoreCutover"), control.marker()),
                Triple.create(PRODUCT, rv("restoreHold"), NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)))))
                return failure("held erasure requires exact positive control guards");
            Node original = uri("urn:rezics:receipt:erasure-graph:" + hash(claims.erasureId()));
            Map<Key, Set<Quad>> expected = new HashMap<>();
            for (String target : claims.targets()) expected.put(new Key(REVISIONS, uri(target)), record(REVISIONS, uri(target), Map.of(
                RDF.type.asNode(), rv("ErasedRevision"), rv("erasureEpoch"), integer(claims.epoch()))));
            expected.put(new Key(RECEIPTS, original), record(RECEIPTS, original, Map.ofEntries(
                Map.entry(RDF.type.asNode(), rv("OperationReceipt")), Map.entry(rv("requestDigest"), text(claims.originalDigest())),
                Map.entry(rv("datasetId"), PRODUCT), Map.entry(rv("dataEpoch"), text(claims.originalEpoch())),
                Map.entry(rv("sequence"), integer(claims.originalSequence())), Map.entry(rv("outcome"), rv("Succeeded")),
                Map.entry(rv("erasureId"), text(claims.erasureId())), Map.entry(rv("erasureEpoch"), integer(claims.epoch())))));
            Node own = uri(receipt);
            expected.put(new Key(RECEIPTS, own), record(RECEIPTS, own, Map.ofEntries(
                Map.entry(RDF.type.asNode(), rv("OperationReceipt")), Map.entry(rv("commandFamily"), text(DOMAIN)),
                Map.entry(rv("requestDigest"), text(digest)), Map.entry(rv("datasetId"), PRODUCT),
                Map.entry(rv("dataEpoch"), control.epoch()), Map.entry(rv("sequence"), integer("0")),
                Map.entry(rv("outcome"), rv("Succeeded")), Map.entry(rv("restoredReceipt"), original),
                Map.entry(rv("restoreCutover"), control.marker()), Map.entry(rv("erasureId"), text(claims.erasureId())),
                Map.entry(rv("erasureEpoch"), integer(claims.epoch())))));
            Set<Quad> inserts = new HashSet<>(); expected.values().forEach(inserts::addAll);
            if (!inserts.equals(new HashSet<>(modify.getInsertQuads()))) return failure("held erasure exact receipt/target tuple differs");
            Map<Key, Set<Quad>> controls = new HashMap<>();
            for (Node subject : List.of(PRODUCT, control.marker(), uri(CommandInvariant.MAIN_STREAM_SCOPE))) {
                Key id = new Key(CONTROL, subject); controls.put(id, stored(data, id));
            }
            Set<Quad> priorOriginal = stored(data, new Key(RECEIPTS, original));
            if (!priorOriginal.isEmpty() && !priorOriginal.equals(expected.get(new Key(RECEIPTS, original))))
                return failure("held erasure original receipt diverges");
            for (String target : claims.targets()) {
                Key id = new Key(REVISIONS, uri(target)); Set<Quad> prior = stored(data, id);
                if (!prior.isEmpty() && !prior.equals(expected.get(id))) return failure("held erasure prior tombstone diverges");
            }
            long existingTargets = claims.targets().stream().filter(target -> !stored(data, new Key(REVISIONS, uri(target))).isEmpty()).count();
            if (priorOriginal.isEmpty() && existingTargets != 0 && existingTargets != claims.targets().size())
                return failure("held erasure captured tombstone set is partial");
            Set<Quad> priorOwn = stored(data, new Key(RECEIPTS, own));
            if (!priorOwn.isEmpty()) {
                Snapshot replay = new Snapshot(control, Map.copyOf(controls), Map.copyOf(expected), Set.of(), true, null);
                String report = check(data, replay);
                return report == null ? replay : failure(report);
            }
            // A captured source already claiming this erasure must have the full
            // exact proof. Missing members are corruption, not a replay cursor.
            if (!priorOriginal.isEmpty()) for (var entry : expected.entrySet()) {
                if (!entry.getKey().equals(new Key(RECEIPTS, own)) && !stored(data, entry.getKey()).equals(entry.getValue()))
                    return failure("held erasure captured original proof is partial");
            }
            if (priorOriginal.isEmpty() && claims.originalEpoch().equals(claims.priorEpoch())
                && new BigInteger(claims.originalSequence()).compareTo(control.priorSequence()) <= 0)
                return failure("held erasure proof is missing from its captured source cut");
            Set<Key> units = indexedUnits(data, claims.targets());
            if (!priorOriginal.isEmpty() && !units.isEmpty()) return failure("held erasure original proof retains indexed content");
            Set<Key> deletes = new HashSet<>();
            modify.getDeleteQuads().forEach(quad -> deletes.add(new Key(quad.getGraph(), quad.getSubject())));
            if (!units.equals(deletes)) return failure("held erasure exact indexed unit inventory changed");
            int total = inserts.size();
            Set<Node> targets = new HashSet<>(); claims.targets().forEach(target -> targets.add(uri(target)));
            for (Key unit : units) {
                Set<Quad> values = stored(data, unit); total += values.size();
                if (!values.contains(new Quad(unit.graph(), unit.subject(), RDF.type.asNode(), rv("MatchUnit")))
                    || values.stream().anyMatch(quad -> REFERENCES.contains(quad.getPredicate()) && !targets.contains(quad.getObject())))
                    return failure("held erasure indexed unit has foreign or missing revision evidence");
            }
            if (total > MAX_QUADS) return failure("held erasure staged quad bound exceeded");
            return new Snapshot(control, Map.copyOf(controls), Map.copyOf(expected), Set.copyOf(units), false, null);
        } catch (Exception unavailable) { return failure("held erasure authentication or exact evidence is unavailable"); }
    }

    /** Check the existing savepoint before applying it; check again on every retry. */
    static String check(DatasetGraph data, Snapshot before) {
        if (before == null || before.error() != null) return before == null ? "held erasure snapshot missing" : before.error();
        if (!before.control().equals(CommandInvariant.readControl(data))) return "held erasure changed restore control";
        for (var entry : before.controls().entrySet()) if (!stored(data, entry.getKey()).equals(entry.getValue()))
            return "held erasure changed retained control/cursor/stream facts";
        for (var entry : before.expected().entrySet()) if (!stored(data, entry.getKey()).equals(entry.getValue()))
            return "held erasure exact proof is partial or divergent";
        for (Key unit : before.units()) if (!stored(data, unit).isEmpty()) return "held erasure indexed unit deletion is partial";
        for (Key id : before.expected().keySet()) if (id.graph().equals(REVISIONS)
            && ErasurePolicy.indexedReference(data, id.subject())) return "held erasure target still has indexed references";
        return null;
    }

    private static Set<Key> indexedUnits(DatasetGraph data, List<String> targets) {
        Set<Key> result = new HashSet<>();
        for (String target : targets) for (Node graph : List.of(PUBLIC, PRIVATE)) for (Node predicate : REFERENCES) {
            var values = data.find(graph, Node.ANY, predicate, uri(target));
            try {
                while (values.hasNext()) {
                    result.add(new Key(graph, values.next().getSubject()));
                    if (result.size() > MAX_UNITS) throw new IllegalArgumentException("held erasure indexed unit bound exceeded");
                }
            } finally { Iter.close(values); }
        }
        return result;
    }

    private static Claims admitted(String receipt, String digest, String update, JsonValue proof, byte[] key) throws Exception {
        if (proof == null || !proof.isObject() || key == null || key.length < 32) throw new IllegalArgumentException("missing admission");
        String payload = ProfileRegistry.required(proof.getAsObject(), "payload"), signature = ProfileRegistry.required(proof.getAsObject(), "signature");
        if (payload.length() > 16_384 || !signature.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("invalid admission");
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
        if (!MessageDigest.isEqual(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)), HexFormat.of().parseHex(signature)))
            throw new IllegalArgumentException("signature differs");
        JsonArray c = JSON.parseAny(payload).getAsArray();
        if (c.size() != 17 || !string(c, 0).equals(DOMAIN) || !string(c, 1).equals(receipt)
            || !string(c, 2).equals(digest) || !string(c, 3).equals(hash(update))) throw new IllegalArgumentException("admission binding differs");
        List<String> targets = new ArrayList<>(); c.get(10).getAsArray().forEach(value -> targets.add(value.getAsString().value()));
        if (targets.isEmpty() || targets.size() > MAX_TARGETS || targets.stream().anyMatch(target -> !target.matches(TARGET))
            || targets.size() != new HashSet<>(targets).size() || !targets.equals(targets.stream().sorted().toList()))
            throw new IllegalArgumentException("exact targets differ");
        Claims claims = new Claims(string(c,4), string(c,5), string(c,6), string(c,7), string(c,8), string(c,9), List.copyOf(targets),
            string(c,11), string(c,12), string(c,13), string(c,15), string(c,16));
        if (!claims.dataEpoch().matches(UUID) || !(claims.routingEpoch().matches("0|[1-9][0-9]*") || claims.routingEpoch().matches(UUID))
            || !claims.marker().equals("urn:rezics:restore:" + claims.dataEpoch()) || !claims.accessGeneration().matches("0|[1-9][0-9]{0,18}")
            || !claims.erasureId().matches(UUID) || !claims.epoch().matches("[1-9][0-9]{0,18}")
            || !claims.originalEpoch().matches(UUID) || claims.originalEpoch().equals(claims.dataEpoch())
            || !claims.originalSequence().matches("[1-9][0-9]*") || !claims.priorEpoch().matches(UUID)
            || !claims.priorSequence().matches("0|[1-9][0-9]*") || !Instant.parse(string(c,14)).isAfter(Instant.now()))
            throw new IllegalArgumentException("admission lineage or expiry differs");
        String originalJson = "{\"family\":\"erasure-graph-v1\",\"erasureId\":\"" + claims.erasureId()
            + "\",\"epoch\":\"" + claims.epoch() + "\",\"targets\":" + strings(claims.targets()) + "}";
        String identity = "[\"" + DOMAIN + "\",\"" + claims.dataEpoch() + "\",\"" + claims.routingEpoch()
            + "\",\"" + claims.marker() + "\",\"" + claims.accessGeneration() + "\",\"" + claims.originalEpoch()
            + "\",\"" + claims.originalSequence() + "\",\"" + claims.originalDigest() + "\",\"" + claims.priorEpoch()
            + "\",\"" + claims.priorSequence() + "\"]";
        if (!hash(originalJson).equals(claims.originalDigest()) || !hash(identity).equals(digest) || !receipt.equals(PREFIX + digest))
            throw new IllegalArgumentException("exact original erasure digest differs");
        return claims;
    }
    private static String string(JsonArray value, int at) { return value.get(at).getAsString().value(); }
    static String hash(String value) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    private static String strings(List<String> values) { return "[\"" + String.join("\",\"", values) + "\"]"; }
    private static boolean positiveEpoch(Node value) {
        return value.isLiteral() && org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger.getURI().equals(value.getLiteralDatatypeURI())
            && value.getLiteralLexicalForm().matches("[1-9][0-9]{0,18}");
    }
    private static Set<Quad> record(Node graph, Node subject, Map<Node, Node> values) {
        Set<Quad> result = new HashSet<>(); values.forEach((predicate, object) -> result.add(new Quad(graph, subject, predicate, object)));
        return Set.copyOf(result);
    }
    private static Set<Quad> stored(DatasetGraph data, Key key) {
        Set<Quad> result = new HashSet<>(); var values = data.find(key.graph(), key.subject(), Node.ANY, Node.ANY);
        try {
            while (values.hasNext()) {
                if (result.size() >= MAX_QUADS) throw new IllegalArgumentException("held erasure subject quad bound exceeded");
                result.add(values.next());
            }
        } finally { Iter.close(values); }
        return Set.copyOf(result);
    }
    private static Set<Triple> guards(UpdateModify modify) {
        Set<Triple> result = new HashSet<>();
        if (!(modify.getWherePattern() instanceof ElementGroup group)) return result;
        for (var element : group.getElements()) if (element instanceof ElementNamedGraph graph && graph.getGraphNameNode().equals(CONTROL)
            && graph.getElement() instanceof ElementGroup triples) for (var block : triples.getElements()) {
            if (block instanceof ElementTriplesBlock values) values.getPattern().forEach(result::add);
            if (block instanceof ElementPathBlock values) values.patternElts().forEachRemaining(path -> { if (path.isTriple()) result.add(path.asTriple()); });
        }
        return result;
    }

    private static void boundedWhere(UpdateModify modify) {
        if (!(modify.getWherePattern() instanceof ElementGroup group))
            throw new IllegalArgumentException("held erasure requires keyed WHERE groups");
        int controls = 0, branches = 0;
        Set<Quad> units = new HashSet<>();
        for (Element element : group.getElements()) {
            if (element instanceof ElementNamedGraph graph && graph.getGraphNameNode().equals(CONTROL)) {
                controls++;
                for (Triple triple : triples(graph.getElement())) if (!triple.getSubject().isURI()
                    || !triple.getPredicate().isURI() || !(triple.getObject().isURI() || triple.getObject().isLiteral()))
                    throw new IllegalArgumentException("held erasure control lookups must be concrete");
            } else {
                if (++branches > 1) throw new IllegalArgumentException("held erasure cannot join unit groups");
                unitBranches(element, units);
            }
        }
        if (controls != 1 || !units.equals(new HashSet<>(modify.getDeleteQuads())))
            throw new IllegalArgumentException("held erasure WHERE must UNION the exact keyed delete inventory");
    }
    private static void unitBranches(Element element, Set<Quad> units) {
        if (element instanceof ElementGroup group && group.getElements().size() == 1) {
            unitBranches(group.getElements().getFirst(), units);
        } else if (element instanceof ElementUnion union) {
            for (Element branch : union.getElements()) unitBranches(branch, units);
        } else if (element instanceof ElementNamedGraph graph && Set.of(PUBLIC, PRIVATE).contains(graph.getGraphNameNode())) {
            Set<Triple> values = triples(graph.getElement());
            if (values.size() != 1) throw new IllegalArgumentException("held erasure unit branch must be keyed");
            Triple triple = values.iterator().next();
            if (!units.add(new Quad(graph.getGraphNameNode(), triple)))
                throw new IllegalArgumentException("held erasure unit branch is duplicated");
        } else throw new IllegalArgumentException("held erasure requires a UNION of keyed unit reads");
    }
    private static Set<Triple> triples(Element element) {
        Set<Triple> result = new HashSet<>();
        if (!(element instanceof ElementGroup group)) throw new IllegalArgumentException("held erasure graph block differs");
        for (Element block : group.getElements()) {
            if (block instanceof ElementTriplesBlock values) values.getPattern().forEach(result::add);
            else if (block instanceof ElementPathBlock values) values.patternElts().forEachRemaining(path -> {
                if (!path.isTriple()) throw new IllegalArgumentException("held erasure paths are unavailable");
                result.add(path.asTriple());
            });
            else throw new IllegalArgumentException("held erasure graph block must contain only keyed triples");
        }
        return result;
    }
    private ErasureRestorePolicy() {}
}
