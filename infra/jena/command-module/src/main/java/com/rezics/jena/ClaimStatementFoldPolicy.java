package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.dboe.base.record.RecordFactory;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.DatasetGraphWrapperView;
import org.apache.jena.sparql.core.GraphView;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.sparql.expr.E_NotExists;
import org.apache.jena.sparql.syntax.*;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.NodeIdFactory;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.vocabulary.RDF;

/** One offline publication-Claim fold. No canonical type deletion outside this exact footprint. */
final class ClaimStatementFoldPolicy {
    private static final String PREFIX = "urn:rezics:name-migration:claim-statement-fold:", FAMILY = "claim-statement-fold-v1";
    private static final String RV = "https://rezics.com/vocab/", XSD = "http://www.w3.org/2001/XMLSchema#";
    private static final String CLAIM = "https://rezics.com/definition/claim-v1", STATEMENT = "https://rezics.com/definition/statement-v1";
    private static final String DEFINITION = "https://rezics.com/definition/semantic-definition-v1";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), RECEIPTS = uri(CommandPolicy.RECEIPTS), PRODUCT = uri("urn:rezics:dataset:product");
    private static final Node PUBLISHED = uri("https://schema.org/datePublished"), TRUE = NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean);
    static final int MAX_SEEK_TUPLES = 128, MAX_RECORD_QUADS = 64, MAX_BLOB_BYTES = 16_384;
    private static final Set<Node> DESCRIPTOR = fields("referent", "interpretationContext", "propositionPredicate", "claimHead", "claimState");
    private static final Set<Node> SOURCE = fields("component", "referent", "interpretationContext", "propositionPredicate", "propositionValue", "valuePrecision", "valueQualifier", "validFrom", "validUntil", "editionScope", "claimStatus", "derivation", "statedBy", "recordedAt", "modelRevision", "shapeRevision", "dataEpoch", "sequence");
    private static final Set<Node> ENVELOPE = fields("commandFamily", "requestDigest", "outcome", "datasetId", "dataEpoch", "sequence", "claimStatementFold", "foldMapDigest", "claimFoldJob");
    private static final Set<Node> CONVERSION = fields("convertedClaim", "sourceClaimRevision", "statementRevision", "relationDefinition", "qualificationDefinition", "sourceDigest", "claimFoldRelationManifest", "claimFoldRelationPayload", "claimFoldQualificationManifest", "claimFoldQualificationPayload", "claimFoldStatementManifest", "claimFoldStatementPayload");
    record Key(Node graph, Node subject) {}
    record Work(int seekTuples, int recordQuads) {}
    record Snapshot(Map<Key, Set<Quad>> expected, String error, Work work) {}
    private static final class Counter { int seeks, quads; Work work() { return new Work(seeks, quads); } }

    static boolean applies(String receipt) { return receipt.startsWith(PREFIX); }
    static String templateDigest(String update) { return hash(update); }
    static Node templateDigestPredicate() { return rv("claimFoldTemplateDigest"); }
    private static String phase(String receipt) {
        if (!receipt.matches(PREFIX + "(acquire|convert|complete|release):[0-9a-f]{64}")) throw bad("unknown phase");
        return receipt.substring(PREFIX.length(), receipt.lastIndexOf(':'));
    }

    static void validateTemplate(CommandPolicy.Plan plan, String receipt) {
        String phase = phase(receipt);
        // There is no trustworthy inventory/seek/effect-reconciliation proof yet.
        if (phase.equals("complete") || phase.equals("release")) throw bad("completion and release require exhaustive reconciled inventory");
        if (plan.request().getOperations().size() != 1 || !(plan.request().getOperations().getFirst() instanceof UpdateModify)) throw bad("one guarded update required");
        var modify = (UpdateModify) plan.request().getOperations().getFirst();
        Node own = uri(receipt), marker = required(modify, RECEIPTS, own, rv("claimStatementFold"));
        Node epoch = required(modify, RECEIPTS, own, rv("dataEpoch")), seq = required(modify, RECEIPTS, own, rv("sequence"));
        String map = string(required(modify, RECEIPTS, own, rv("foldMapDigest")));
        String job = string(required(modify, RECEIPTS, own, rv("claimFoldJob")));
        if (!marker.isURI() || !marker.getURI().matches("urn:rezics:maintenance:claim-statement-fold:[0-9a-f]{64}") || !map.matches("[0-9a-f]{64}")
            || !job.matches("[A-Za-z0-9:_-]{1,128}") || string(epoch).isEmpty() || !seq.isVariable()
            || !required(modify, RECEIPTS, own, RDF.type.asNode()).equals(rv("OperationReceipt"))
            || !required(modify, RECEIPTS, own, rv("requestDigest")).equals(text(receipt.substring(receipt.lastIndexOf(':') + 1)))
            || !required(modify, RECEIPTS, own, rv("commandFamily")).equals(text("claim-statement-fold-" + phase + "-v1"))
            || !required(modify, RECEIPTS, own, rv("datasetId")).equals(PRODUCT)
            || !required(modify, RECEIPTS, own, rv("outcome")).equals(rv("Succeeded"))) throw bad("envelope differs");
        Set<Node> ownFields = new HashSet<>(ENVELOPE); ownFields.add(RDF.type.asNode());
        if (phase.equals("convert")) ownFields.addAll(CONVERSION);
        Set<Quad> controls = phase.equals("acquire") ? Set.of(new Quad(CONTROL, PRODUCT, rv("restoreHold"), TRUE),
            new Quad(CONTROL, marker, rv("claimStatementFoldFence"), TRUE), new Quad(CONTROL, marker, rv("foldMapDigest"), text(map))) : Set.of();
        if (!quads(modify.getInsertQuads(), CONTROL).equals(controls) || !quads(modify.getDeleteQuads(), CONTROL).isEmpty()) throw bad("control footprint differs");
        Node claim = phase.equals("convert") ? required(modify, RECEIPTS, own, rv("convertedClaim")) : null;
        Node root = phase.equals("convert") ? required(modify, RECEIPTS, own, rv("sourceClaimRevision")) : null;
        Node revision = phase.equals("convert") ? required(modify, RECEIPTS, own, rv("statementRevision")) : null;
        if (claim != null && (!nativeId(claim) || !nativeId(root) || !nativeId(revision) || claim.equals(root) || claim.equals(revision) || root.equals(revision))) throw bad("conversion identities differ");
        for (Quad quad : modify.getInsertQuads()) {
            if (!quad.getPredicate().isURI() || !(quad.getObject().isURI() || quad.getObject().isLiteral()
                || quad.getGraph().equals(RECEIPTS) && quad.getPredicate().equals(rv("sequence")) && quad.getObject().equals(seq))) throw bad("concrete values required");
            if (quad.getGraph().equals(RECEIPTS)) {
                if (!quad.getSubject().equals(own) || !ownFields.contains(quad.getPredicate())) throw bad("receipt footprint differs");
            } else if (quad.getGraph().equals(CONTROL)) { /* exact set above */ }
            else if (!phase.equals("convert") || !(quad.getGraph().equals(CURRENT) && quad.getSubject().equals(claim)
                || quad.getGraph().equals(REVISIONS) && Set.of(claim, revision).contains(quad.getSubject()))) throw bad("data footprint differs");
        }
        for (Node field : ownFields) required(modify, RECEIPTS, own, field);
        for (Quad quad : modify.getDeleteQuads()) if (!phase.equals("convert") || !quad.getGraph().equals(CURRENT)
            || !quad.getSubject().equals(claim) || !(DESCRIPTOR.contains(quad.getPredicate()) || quad.getPredicate().equals(RDF.type.asNode()))
            || !quad.getObject().isURI()) throw bad("only six exact Claim descriptor deletions admitted");
        if (new HashSet<>(modify.getInsertQuads()).size() != modify.getInsertQuads().size()
            || new HashSet<>(modify.getDeleteQuads()).size() != modify.getDeleteQuads().size()
            || modify.getDeleteQuads().size() != (claim == null ? 0 : 6)) throw bad("ambiguous footprint");
        if (!positive(modify.getWherePattern(), CONTROL, PRODUCT, rv("dataEpoch"), epoch)
            || !positive(modify.getWherePattern(), CONTROL, PRODUCT, rv("sequence"), seq)) throw bad("positive lineage guards required");
        if (claim != null && (!positive(modify.getWherePattern(), CONTROL, PRODUCT, rv("restoreHold"), TRUE)
            || !positive(modify.getWherePattern(), CONTROL, marker, rv("claimStatementFoldFence"), TRUE)
            || !positive(modify.getWherePattern(), CONTROL, marker, rv("foldMapDigest"), text(map)))) throw bad("owned fence guards required");
    }

    static Snapshot capture(DatasetGraph logical, String receipt, String digest, CommandPolicy.Plan plan) {
        Counter count = new Counter();
        try {
            validateTemplate(plan, receipt);
            // CurrentScope's default metadata and synthetic revisions cannot establish retained Claim proof.
            DatasetGraph data = TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
            var modify = (UpdateModify) plan.request().getOperations().getFirst();
            var control = CommandInvariant.readControl(data);
            if (control == null || !CommandInvariant.hasControlGuards(plan, control)) throw bad("epoch, routing and sequence guards differ");
            Node own = uri(receipt), marker = required(modify, RECEIPTS, own, rv("claimStatementFold"));
            String map = string(required(modify, RECEIPTS, own, rv("foldMapDigest"))), job = string(required(modify, RECEIPTS, own, rv("claimFoldJob")));
            String epoch = string(control.epoch()), routing = string(control.routing()), phase = phase(receipt);
            if (epoch.length() > 128 || routing.length() > 128) throw bad("lineage text exceeds fixed bound");
            if (!marker.equals(uri("urn:rezics:maintenance:claim-statement-fold:" + hash(json(Arrays.asList(epoch, routing, map, job)))))) throw bad("marker identity differs");
            Map<Key, Set<Quad>> expected = new LinkedHashMap<>();
            Set<Quad> product = stored(data, CONTROL, PRODUCT, MAX_RECORD_QUADS, count);
            Set<Quad> held = stored(data, CONTROL, marker, 4, count);
            Map<String, Object> fence = new LinkedHashMap<>(); fence.put("marker", marker.getURI()); fence.put("mapDigest", map); fence.put("job", job);
            List<Object> identities = new ArrayList<>();
            if (phase.equals("acquire")) {
                if (control.held() || !held.isEmpty()) throw bad("original restore or unrelated hold must finish first");
                product.add(new Quad(CONTROL, PRODUCT, rv("restoreHold"), TRUE));
                // An explicit false is not replaced by an unguarded insert.
                if (product.stream().filter(q -> q.getPredicate().equals(rv("restoreHold"))).count() != 1) throw bad("ambiguous hold");
                held.add(new Quad(CONTROL, marker, rv("claimStatementFoldFence"), TRUE));
                held.add(new Quad(CONTROL, marker, rv("foldMapDigest"), text(map)));
            } else {
                if (!control.held() || !values(product, rv("restoreHold")).equals(Set.of(TRUE)) || !held.equals(Set.of(new Quad(CONTROL, marker, rv("claimStatementFoldFence"), TRUE), new Quad(CONTROL, marker, rv("foldMapDigest"), text(map))))) throw bad("owned fence unavailable");
                String acquisitionDigest = hash(json(Arrays.asList(FAMILY, "acquire", epoch, routing, fence)));
                Node acquisition = uri(PREFIX + "acquire:" + acquisitionDigest);
                Set<Quad> acquired = stored(data, RECEIPTS, acquisition, 11, count);
                Set<Quad> acquisitionFields = record(RECEIPTS, acquisition, Map.ofEntries(
                    Map.entry(RDF.type.asNode(), rv("OperationReceipt")), Map.entry(rv("commandFamily"), text("claim-statement-fold-acquire-v1")),
                    Map.entry(rv("requestDigest"), text(acquisitionDigest)), Map.entry(rv("outcome"), rv("Succeeded")), Map.entry(rv("datasetId"), PRODUCT),
                    Map.entry(rv("dataEpoch"), control.epoch()), Map.entry(rv("sequence"), one(product, rv("sequence"))), Map.entry(rv("claimStatementFold"), marker),
                    Map.entry(rv("foldMapDigest"), text(map)), Map.entry(rv("claimFoldJob"), text(job))));
                Node acquiredTemplate = optional(acquired, templateDigestPredicate());
                if (acquiredTemplate == null || !string(acquiredTemplate).matches("[0-9a-f]{64}")) throw bad("exact acquired job receipt unavailable");
                acquisitionFields.add(new Quad(RECEIPTS, acquisition, templateDigestPredicate(), acquiredTemplate));
                if (!acquired.equals(acquisitionFields)) throw bad("acquired job receipt differs");
                expected.put(new Key(RECEIPTS, acquisition), acquired);
                conversion(data, modify, own, map, expected, identities, count);
            }
            closedWhere(data, modify, own, phase, expected.keySet(), marker, count);
            List<Object> envelope = new ArrayList<>(Arrays.asList(FAMILY, phase, epoch, routing, fence)); envelope.addAll(identities);
            if (!hash(json(envelope)).equals(digest) || !receipt.equals(PREFIX + phase + ':' + digest)) throw bad("exact envelope digest differs");
            expected.put(new Key(CONTROL, PRODUCT), product); expected.put(new Key(CONTROL, marker), held);
            Node actualSequence = one(product, rv("sequence"));
            Set<Quad> ownReceipt = new HashSet<>();
            for (Quad quad : modify.getInsertQuads()) if (quad.getGraph().equals(RECEIPTS)) ownReceipt.add(new Quad(RECEIPTS, own, quad.getPredicate(), quad.getObject().isVariable() ? actualSequence : quad.getObject()));
            if (!stored(data, RECEIPTS, own, MAX_RECORD_QUADS, count).isEmpty()) throw bad("receipt exists; exact template replay required");
            expected.put(new Key(RECEIPTS, own), ownReceipt);
            Node stream = uri(CommandInvariant.MAIN_STREAM_SCOPE);
            expected.put(new Key(CONTROL, stream), stored(data, CONTROL, stream, 8, count));
            return new Snapshot(Map.copyOf(expected), null, count.work());
        } catch (IllegalArgumentException ex) { return new Snapshot(Map.of(), ex.getMessage(), count.work()); }
    }

    private static void conversion(DatasetGraph data, UpdateModify modify, Node own, String map,
        Map<Key, Set<Quad>> expected, List<Object> identities, Counter count) {
        Node claim = required(modify, RECEIPTS, own, rv("convertedClaim")), root = required(modify, RECEIPTS, own, rv("sourceClaimRevision"));
        Node revision = required(modify, RECEIPTS, own, rv("statementRevision"));
        Node relation = required(modify, RECEIPTS, own, rv("relationDefinition")), qualification = required(modify, RECEIPTS, own, rv("qualificationDefinition"));
        if (!nativeId(relation) || !nativeId(qualification) || relation.equals(qualification)
            || !hash(json(List.of(FAMILY, PUBLISHED.getURI(), relation.getURI(), qualification.getURI()))).equals(map)) throw bad("fixed definition map differs");
        refuseDefault(data, claim, count); refuseDefault(data, root, count); refuseDefault(data, revision, count);
        Set<Quad> current = stored(data, CURRENT, claim, 6, count), source = stored(data, REVISIONS, root, 40, count);
        Set<Node> currentFields = new HashSet<>(DESCRIPTOR); currentFields.add(RDF.type.asNode());
        if (current.size() != 6 || !predicates(current).equals(currentFields) || !one(current, RDF.type.asNode()).equals(rv("Claim"))
            || !one(current, rv("claimHead")).equals(root) || !one(current, rv("claimState")).equals(rv("Active"))) throw bad("exact current Claim descriptor differs");
        Set<Node> sourceFields = new HashSet<>(SOURCE); sourceFields.add(RDF.type.asNode());
        if (!sourceFields.containsAll(predicates(source)) || !values(source, RDF.type.asNode()).equals(Set.of(rv("ClaimRevision"), rv("RevisionAnchor")))
            || !one(source, rv("component")).equals(claim) || !one(source, rv("claimStatus")).equals(rv("Asserted"))
            || !one(source, rv("modelRevision")).equals(uri(CLAIM)) || !one(source, rv("shapeRevision")).equals(uri(CLAIM))) throw bad("retained Claim revision shape differs");
        for (String field : List.of("referent", "interpretationContext", "propositionPredicate")) {
            Node value = one(source, rv(field)); reference(value);
            if (!value.equals(one(current, rv(field)))) throw bad("retained proposition identity differs");
        }
        for (Set<Quad> record : List.of(current, source)) for (Quad guard : record)
            if (!positive(modify.getWherePattern(), guard.getGraph(), guard.getSubject(), guard.getPredicate(), guard.getObject())) throw bad("exact current/source guards omitted");
        if (!one(source, rv("propositionPredicate")).equals(PUBLISHED)) throw bad("predicate is unreviewed");
        if (!intersection(data, REVISIONS, List.of(new Node[]{RDF.type.asNode(), rv("ClaimRevision")}, new Node[]{rv("component"), claim}), count).equals(Set.of(root))) throw bad("source is not the sole root Claim revision");
        Node value = one(source, rv("propositionValue")); publicationDate(value);
        Node speaker = one(source, rv("statedBy")); if (!nativeId(speaker)) throw bad("public speaker differs");
        Node recorded = one(source, rv("recordedAt")); canonicalInstant(recorded);
        Node from = optional(source, rv("validFrom")), until = optional(source, rv("validUntil"));
        String fromKey = from == null ? null : canonicalInstant(from), untilKey = until == null ? null : canonicalInstant(until);
        if (fromKey != null && untilKey != null && fromKey.compareTo(untilKey) >= 0) throw bad("validity interval differs");
        Node edition = optional(source, rv("editionScope")), derivation = optional(source, rv("derivation"));
        if (edition != null) reference(edition); if (derivation != null) reference(derivation);
        Node precision = one(source, rv("valuePrecision"));
        String precisionWord = Map.of(rv("ExactValue"), "exact", rv("ApproximateValue"), "approximate", rv("UncertainValue"), "uncertain").get(precision);
        if (precisionWord == null) throw bad("precision term differs");
        List<String> qualifierWords = new ArrayList<>();
        for (Node term : values(source, rv("valueQualifier"))) {
            String word = Map.of(rv("DisputedAttribution"), "disputed-attribution", rv("InferredValue"), "inferred").get(term);
            if (word == null) throw bad("qualifier term differs"); qualifierWords.add(word);
        }
        Collections.sort(qualifierWords);
        Node sourceEpoch = one(source, rv("dataEpoch")), sequence = one(source, rv("sequence"));
        if (string(sourceEpoch).isEmpty() || string(sourceEpoch).length() > 128 || !typed(sequence, "integer") || !sequence.getLiteralLexicalForm().matches("[1-9][0-9]*")) throw bad("source position differs");
        Set<Node> originals = intersection(data, RECEIPTS, List.of(new Node[]{rv("claim"), claim}, new Node[]{rv("claimRevision"), root},
            new Node[]{RDF.type.asNode(), rv("OperationReceipt")}, new Node[]{rv("outcome"), rv("Succeeded")}), count);
        if (originals.size() != 1) throw bad("unique successful source receipt unavailable");
        Node original = originals.iterator().next(); Set<Quad> originalRecord = stored(data, RECEIPTS, original, 32, count);
        String admission = string(one(originalRecord, rv("admissionId"))), digest = string(one(originalRecord, rv("requestDigest")));
        Node operation = one(originalRecord, rv("operation"));
        if (!one(originalRecord, RDF.type.asNode()).equals(rv("OperationReceipt")) || !one(originalRecord, rv("outcome")).equals(rv("Succeeded"))
            || !one(originalRecord, rv("claim")).equals(claim) || !one(originalRecord, rv("claimRevision")).equals(root)
            || !admission.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") || !digest.matches("[0-9a-f]{64}")
            || !original.equals(uri("urn:rezics:receipt:" + hash(admission + '\0' + "claim-create"))) || !nativeId(operation)
            || !one(originalRecord, rv("admittedScope")).equals(text("verification:claim:global"))
            || !string(one(originalRecord, rv("authorityEpoch"))).matches("[0-9]+")
            || !one(originalRecord, rv("datasetId")).equals(PRODUCT)
            || !one(originalRecord, rv("dataEpoch")).equals(sourceEpoch) || !one(originalRecord, rv("sequence")).equals(sequence)) throw bad("original source receipt differs");
        definition(data, modify, own, relation, "PropertyDefinition", "statement-first-publication-date-v1", "Relation", expected, count);
        definition(data, modify, own, qualification, "InterpretationDefinition", "statement-proposition-qualification-v1", "Qualification", expected, count);
        Node subject = one(source, rv("referent")), context = one(source, rv("interpretationContext"));
        List<Object> qualificationKey = Arrays.asList(qualification.getURI(), context.getURI(), precisionWord, qualifierWords, fromKey, untilKey, edition == null ? null : edition.getURI());
        Node key = uri("urn:rezics:meaning:" + hash(json(Arrays.asList("statement-meaning-v2", subject.getURI(), PUBLISHED.getURI(), relation.getURI(), List.of(qualification.getURI()),
            Arrays.asList("literal", value.getLiteralLexicalForm(), value.getLiteralDatatypeURI(), null), List.of(), qualificationKey))));
        List<Object> receiptTerms = new ArrayList<>(); receiptTerms.add(termIdentity(original));
        for (String field : List.of("operation", "admissionId", "requestDigest", "authorityEpoch", "admittedScope", "dataEpoch", "sequence")) receiptTerms.add(termIdentity(one(originalRecord, rv(field))));
        String sourceDigest = hash(json(Arrays.asList(propertyIdentity(current), propertyIdentity(source), receiptTerms, relation.getURI(), qualification.getURI(), key.getURI())));
        if (!required(modify, RECEIPTS, own, rv("sourceDigest")).equals(text(sourceDigest))) throw bad("source snapshot digest differs");
        String id = hash(json(List.of(FAMILY, claim.getURI(), root.getURI(), sourceDigest))).substring(0, 32);
        Node expectedRevision = uri("https://rezics.com/id/" + id.substring(0, 8) + '-' + id.substring(8, 12) + '-' + id.substring(12, 16) + '-' + id.substring(16, 20) + '-' + id.substring(20));
        if (!revision.equals(expectedRevision)) throw bad("fresh B identity differs");
        if (!stored(data, REVISIONS, revision, MAX_RECORD_QUADS, count).isEmpty() || !stored(data, CURRENT, revision, MAX_RECORD_QUADS, count).isEmpty()) throw bad("B is not fresh");
        Set<Quad> archive = stored(data, REVISIONS, claim, 6, count), historical = new HashSet<>();
        for (Quad quad : current) historical.add(new Quad(REVISIONS, quad.asTriple()));
        if (!archive.isEmpty() && !archive.equals(historical)) throw bad("conflicting historical Claim descriptor");
        Set<Quad> statement = record(CURRENT, claim, Map.ofEntries(Map.entry(RDF.type.asNode(), RDF.Statement.asNode()),
            Map.entry(RDF.subject.asNode(), subject), Map.entry(RDF.predicate.asNode(), PUBLISHED), Map.entry(RDF.object.asNode(), value),
            Map.entry(rv("relationDefinition"), relation), Map.entry(rv("interpretationDefinition"), qualification), Map.entry(rv("qualificationDefinition"), qualification),
            Map.entry(rv("interpretationContext"), context), Map.entry(rv("valuePrecision"), precision), Map.entry(rv("speaker"), speaker),
            Map.entry(rv("meaningKey"), key), Map.entry(rv("statementState"), rv("Active")), Map.entry(rv("head"), revision), Map.entry(rv("retainedClaimHead"), root)));
        for (Node term : values(source, rv("valueQualifier"))) statement.add(new Quad(CURRENT, claim, rv("valueQualifier"), term));
        for (String field : List.of("validFrom", "validUntil", "editionScope")) { Node term = optional(source, rv(field)); if (term != null) statement.add(new Quad(CURRENT, claim, rv(field), term)); }
        Node manifest = required(modify, REVISIONS, revision, rv("manifest"));
        Set<Quad> anchor = record(REVISIONS, revision, Map.ofEntries(Map.entry(RDF.type.asNode(), rv("StatementRevision")), Map.entry(rv("component"), claim),
            Map.entry(rv("statementState"), rv("Active")), Map.entry(rv("recordedBy"), speaker), Map.entry(rv("operation"), operation), Map.entry(rv("retainedSourceRevision"), root),
            Map.entry(rv("retainedSourceReceipt"), original), Map.entry(rv("recordedAt"), recorded), Map.entry(rv("modelRevision"), uri(STATEMENT)), Map.entry(rv("shapeRevision"), uri(STATEMENT)),
            Map.entry(rv("manifest"), manifest), Map.entry(rv("dataEpoch"), sourceEpoch), Map.entry(rv("sequence"), sequence)));
        anchor.add(new Quad(REVISIONS, revision, RDF.type.asNode(), rv("RevisionAnchor")));
        if (derivation != null) anchor.add(new Quad(REVISIONS, revision, rv("derivation"), derivation));
        if (!quads(modify.getDeleteQuads(), CURRENT).equals(current) || !subjectQuads(modify.getInsertQuads(), CURRENT, claim).equals(statement)
            || !subjectQuads(modify.getInsertQuads(), REVISIONS, claim).equals(historical) || !subjectQuads(modify.getInsertQuads(), REVISIONS, revision).equals(anchor)) throw bad("exact representation footprint differs");
        Map<String, Object> qualificationState = map("definition", qualification.getURI(), "interpretationContext", context.getURI(), "valuePrecision", precisionWord,
            "valueQualifiers", qualifierWords, "validFrom", from == null ? null : from.getLiteralLexicalForm(), "validUntil", until == null ? null : until.getLiteralLexicalForm(), "editionScope", edition == null ? null : edition.getURI());
        Map<String, Object> meaning = map("subject", subject.getURI(), "applicability", List.of(), "predicate", PUBLISHED.getURI(), "relationDefinition", relation.getURI(), "interpretationDefinitions", List.of(qualification.getURI()),
            "value", map("kind", "literal", "lexical", value.getLiteralLexicalForm(), "datatype", value.getLiteralDatatypeURI(), "language", null), "qualification", qualificationState, "referenceDomain", "retained-claim");
        Map<String, Object> state = map("revision", revision.getURI(), "meaning", meaning, "meaningKey", key.getURI(), "speaker", speaker.getURI(), "semanticContextRevision", null,
            "state", "active", "evidence", List.of(), "recordedBy", speaker.getURI(), "retainedSourceRevision", root.getURI(), "retainedSourceReceipt", original.getURI(), "recordedAt", recorded.getLiteralLexicalForm());
        if (derivation != null) state.put("derivation", derivation.getURI());
        JsonObject sealed = sealed(modify, own, "Statement", manifest, claim, STATEMENT);
        if (!sealed.equals(JSON.parse(json(state)))) throw bad("sealed B state differs from retained proposition and provenance");
        expected.put(new Key(CURRENT, claim), statement); expected.put(new Key(REVISIONS, claim), historical);
        expected.put(new Key(REVISIONS, root), source); expected.put(new Key(REVISIONS, revision), anchor);
        expected.put(new Key(RECEIPTS, original), originalRecord);
        identities.addAll(List.of(claim.getURI(), root.getURI(), revision.getURI(), sourceDigest));
    }

    private static void definition(DatasetGraph data, UpdateModify modify, Node own, Node revision, String kind, String notation,
        String blob, Map<Key, Set<Quad>> expected, Counter count) {
        refuseDefault(data, revision, count);
        Set<Quad> anchor = stored(data, REVISIONS, revision, MAX_RECORD_QUADS, count);
        Node component = one(anchor, rv("component")), manifest = one(anchor, rv("manifest"));
        Set<Node> anchorFields = new HashSet<>(fields("component", "predecessor", "definitionKind", "lifecycle", "operation", "manifest", "modelGeneration", "modelRevision", "shapeRevision", "datasetId", "dataEpoch", "sequence"));
        anchorFields.add(RDF.type.asNode());
        if (!anchorFields.containsAll(predicates(anchor)) || !nativeId(component) || !values(anchor, RDF.type.asNode()).equals(Set.of(rv("DefinitionRevision"), rv("RevisionAnchor")))
            || !one(anchor, rv("definitionKind")).equals(rv(kind)) || !one(anchor, rv("lifecycle")).equals(rv("Active"))
            || !one(anchor, rv("modelRevision")).equals(uri(DEFINITION)) || !one(anchor, rv("shapeRevision")).equals(uri(DEFINITION))) throw bad("native definition revision differs");
        refuseDefault(data, component, count);
        Set<Quad> current = stored(data, CURRENT, component, MAX_RECORD_QUADS, count);
        if (current.size() != 3 || !one(current, RDF.type.asNode()).equals(rv("SemanticDefinition")) || !one(current, rv("definitionHead")).equals(revision)
            || !one(current, rv("definitionKind")).equals(rv(kind))) throw bad("native definition head or kind differs");
        if (!nativeId(one(anchor, rv("operation"))) || !one(anchor, rv("datasetId")).equals(PRODUCT)
            || string(one(anchor, rv("dataEpoch"))).isEmpty() || string(one(anchor, rv("dataEpoch"))).length() > 128
            || !typed(one(anchor, rv("sequence")), "integer") || new BigInteger(one(anchor, rv("sequence")).getLiteralLexicalForm()).signum() < 1) throw bad("native definition provenance differs");
        Node generation = one(anchor, rv("modelGeneration")), predecessor = optional(anchor, rv("predecessor"));
        if (!generation.isURI() || !data.contains(REVISIONS, generation, RDF.type.asNode(), rv("ModelGeneration"))
            || predecessor != null && (!predecessor.isURI() || !data.contains(REVISIONS, predecessor, RDF.type.asNode(), rv("DefinitionRevision")))) throw bad("native definition model or predecessor shape differs");
        Node lifecycle = uri("urn:rezics:definition-lifecycle:" + hash(revision.getURI()));
        Set<Node> controls = intersection(data, CURRENT, List.of(new Node[]{rv("definitionRef"), revision}, new Node[]{RDF.type.asNode(), rv("DefinitionLifecycle")}), count);
        if (!controls.isEmpty() && !controls.equals(Set.of(lifecycle))) throw bad("unreviewed definition lifecycle owner");
        Set<Quad> lifecycleRecord = stored(data, CURRENT, lifecycle, MAX_RECORD_QUADS, count); refuseDefault(data, lifecycle, count);
        if (!lifecycleRecord.isEmpty() && (!one(lifecycleRecord, RDF.type.asNode()).equals(rv("DefinitionLifecycle"))
            || lifecycleRecord.size() != 4 || !one(lifecycleRecord, rv("definitionRef")).equals(revision) || !one(lifecycleRecord, rv("definitionState")).equals(rv("Active"))
            || !one(lifecycleRecord, rv("definitionHead")).isURI())) throw bad("definition lifecycle unavailable or retired");
        JsonObject state = sealed(modify, own, blob, manifest, component, DEFINITION);
        if (!state.keys().equals(Set.of("component", "kind", "lifecycle", "successor", "roles", "notation"))
            || !jsonString(state, "component").equals("definition") || !jsonString(state, "kind").equals(kind.equals("PropertyDefinition") ? "property" : "interpretation")
            || !jsonString(state, "lifecycle").equals("active") || !state.get("successor").isNull()
            || !state.get("roles").isArray() || state.get("roles").getAsArray().size() != 0 || !jsonString(state, "notation").equals(notation)) throw bad("sealed definition meaning differs");
        for (Quad guard : List.of(new Quad(CURRENT, component, RDF.type.asNode(), rv("SemanticDefinition")), new Quad(CURRENT, component, rv("definitionKind"), rv(kind)), new Quad(CURRENT, component, rv("definitionHead"), revision),
            new Quad(REVISIONS, revision, RDF.type.asNode(), rv("DefinitionRevision")), new Quad(REVISIONS, revision, rv("component"), component), new Quad(REVISIONS, revision, rv("manifest"), manifest),
            new Quad(REVISIONS, revision, rv("definitionKind"), rv(kind)), new Quad(REVISIONS, revision, rv("lifecycle"), rv("Active"))))
            if (!positive(modify.getWherePattern(), guard.getGraph(), guard.getSubject(), guard.getPredicate(), guard.getObject())) throw bad("exact sealed definition guards omitted");
        expected.put(new Key(CURRENT, component), current); expected.put(new Key(REVISIONS, revision), anchor); expected.put(new Key(CURRENT, lifecycle), lifecycleRecord);
    }

    /** The native proof discharges the finite emitted guard set. No operator
     * WHERE query is executed: even a correct anti-join may otherwise scan history. */
    private static void closedWhere(DatasetGraph data, UpdateModify modify, Node own, String phase,
        Set<Key> conversionKeys, Node marker, Counter count) {
        Set<Key> allowed = new HashSet<>(conversionKeys);
        allowed.add(new Key(CONTROL, PRODUCT)); allowed.add(new Key(CONTROL, marker));
        Map<Key, Set<Quad>> records = new HashMap<>();
        Node sequence = required(modify, RECEIPTS, own, rv("sequence"));
        Node revision = phase.equals("convert") ? required(modify, RECEIPTS, own, rv("statementRevision")) : null;
        Node relation = phase.equals("convert") ? required(modify, RECEIPTS, own, rv("relationDefinition")) : null;
        Node qualification = phase.equals("convert") ? required(modify, RECEIPTS, own, rv("qualificationDefinition")) : null;
        class Guards {
            void visit(Element element, boolean negative, Node graph) {
                if (element instanceof ElementGroup group) { for (Element child : group.getElements()) visit(child, negative, graph); return; }
                if (element instanceof ElementNamedGraph named) {
                    if (graph != null || !named.getGraphNameNode().isURI()) throw bad("nested or variable guard graph");
                    visit(named.getElement(), negative, named.getGraphNameNode()); return;
                }
                if (!negative && graph == null && element instanceof ElementFilter filter && filter.getExpr() instanceof E_NotExists absent) {
                    if (phase.equals("convert") && retirementGuard(absent.getElement(), relation, qualification)) return;
                    List<Quad> quads = guardQuads(absent.getElement(), null);
                    if (quads.size() != 1) throw bad("unsupported absence guard");
                    Quad guard = quads.getFirst();
                    boolean ownReceipt = guard.getGraph().equals(RECEIPTS) && guard.getSubject().equals(own) && guard.getPredicate().isVariable() && guard.getObject().isVariable();
                    boolean freshB = revision != null && guard.getGraph().equals(REVISIONS) && guard.getSubject().equals(revision) && guard.getPredicate().isVariable() && guard.getObject().isVariable();
                    boolean noHold = phase.equals("acquire") && guard.equals(new Quad(CONTROL, PRODUCT, rv("restoreHold"), TRUE));
                    if (!ownReceipt && !freshB && !noHold) throw bad("unsupported absence guard");
                    return;
                }
                if (graph == null) throw bad("only fixed named guard patterns admitted");
                List<org.apache.jena.graph.Triple> triples = guardTriples(element);
                for (var triple : triples) {
                    Node object = triple.getObject();
                    if (graph.equals(CONTROL) && triple.getSubject().equals(PRODUCT) && triple.getPredicate().equals(rv("sequence")) && object.equals(sequence)) {
                        object = one(records.computeIfAbsent(new Key(CONTROL, PRODUCT), key -> stored(data, key.graph(), key.subject(), MAX_RECORD_QUADS, count)), rv("sequence"));
                    }
                    Key key = new Key(graph, triple.getSubject());
                    if (!allowed.contains(key) || !triple.getSubject().isURI() || !triple.getPredicate().isURI()
                        || !(object.isURI() || object.isLiteral())) throw bad("unbounded or unrelated guard pattern");
                    Set<Quad> record = records.computeIfAbsent(key, value -> stored(data, value.graph(), value.subject(), MAX_RECORD_QUADS, count));
                    if (!record.contains(new Quad(graph, triple.getSubject(), triple.getPredicate(), object))) throw bad("fixed guard is unavailable");
                }
            }
        }
        new Guards().visit(modify.getWherePattern(), false, null);
    }
    private static List<org.apache.jena.graph.Triple> guardTriples(Element element) {
        List<org.apache.jena.graph.Triple> result = new ArrayList<>();
        if (element instanceof ElementTriplesBlock block) block.patternElts().forEachRemaining(result::add);
        else if (element instanceof ElementPathBlock block) {
            var rows = block.patternElts(); while (rows.hasNext()) { var path = rows.next(); if (!path.isTriple()) throw bad("guard property paths refused"); result.add(path.asTriple()); }
        } else throw bad("unsupported guard expression");
        return result;
    }
    private static List<Quad> guardQuads(Element element, Node graph) {
        List<Quad> result = new ArrayList<>();
        if (element instanceof ElementGroup group) for (Element child : group.getElements()) result.addAll(guardQuads(child, graph));
        else if (element instanceof ElementNamedGraph named && graph == null && named.getGraphNameNode().isURI()) result.addAll(guardQuads(named.getElement(), named.getGraphNameNode()));
        else if (graph != null) for (var triple : guardTriples(element)) result.add(new Quad(graph, triple));
        else throw bad("unsupported guard structure");
        return result;
    }
    private static boolean retirementGuard(Element element, Node relation, Node qualification) {
        if (!(element instanceof ElementGroup group) || group.getElements().size() != 2) return false;
        ElementData values = null; Element pattern = null;
        for (Element child : group.getElements()) { if (child instanceof ElementData table) values = table; else pattern = child; }
        if (values == null || values.getVars().size() != 1 || values.getRows().size() != 2 || pattern == null) return false;
        Set<Node> definitions = new HashSet<>(); for (var row : values.getRows()) definitions.add(row.get(values.getVars().getFirst()));
        if (!definitions.equals(Set.of(relation, qualification))) return false;
        List<Quad> quads = guardQuads(pattern, null);
        if (quads.size() != 3) return false;
        Node controller = quads.getFirst().getSubject(); if (!controller.isVariable()) return false;
        return new HashSet<>(quads).equals(Set.of(new Quad(CURRENT, controller, RDF.type.asNode(), rv("DefinitionLifecycle")),
            new Quad(CURRENT, controller, rv("definitionRef"), values.getVars().getFirst()), new Quad(CURRENT, controller, rv("definitionState"), rv("Retired"))));
    }
    static void applyExact(DatasetGraph data, Snapshot before, CommandPolicy.Plan plan) {
        if (before.error() != null) throw bad("refused prestate cannot apply");
        var modify = (UpdateModify) plan.request().getOperations().getFirst();
        Set<Quad> product = before.expected().get(new Key(CONTROL, PRODUCT));
        if (product == null) throw bad("native lineage proof unavailable");
        Node sequence = one(product, rv("sequence"));
        for (Quad quad : modify.getDeleteQuads()) data.delete(quad);
        for (Quad quad : modify.getInsertQuads()) data.add(quad.getObject().isVariable()
            ? new Quad(quad.getGraph(), quad.getSubject(), quad.getPredicate(), sequence) : quad);
    }

    /** Hash exact supplied object bytes; parsing never recreates an operator's purported sealed bytes. */
    private static JsonObject sealed(UpdateModify modify, Node own, String role, Node manifest, Node component, String profile) {
        String manifestBytes = string(required(modify, RECEIPTS, own, rv("claimFold" + role + "Manifest")));
        String payloadBytes = string(required(modify, RECEIPTS, own, rv("claimFold" + role + "Payload")));
        if (manifestBytes.getBytes(StandardCharsets.UTF_8).length > MAX_BLOB_BYTES || payloadBytes.getBytes(StandardCharsets.UTF_8).length > MAX_BLOB_BYTES
            || !manifest.equals(uri("urn:rezics:sha256:" + hash(manifestBytes)))) throw bad("sealed manifest bytes differ");
        JsonObject descriptor = strictJson(manifestBytes), payload = strictJson(payloadBytes);
        if (!descriptor.keys().equals(Set.of("format", "component", "payload", "payloadBytes", "mediaType", "model", "shape"))
            || !jsonString(descriptor, "format").equals("rezics-manifest-v1") || !jsonString(descriptor, "component").equals(component.getURI())
            || !jsonString(descriptor, "payload").equals("sha256:" + hash(payloadBytes)) || !jsonString(descriptor, "mediaType").equals("application/json")
            || !jsonString(descriptor, "model").equals(profile) || !jsonString(descriptor, "shape").equals(profile)
            || !descriptor.get("payloadBytes").isNumber() || !descriptor.get("payloadBytes").getAsNumber().value().toString().equals(Integer.toString(payloadBytes.getBytes(StandardCharsets.UTF_8).length))
            || !payload.keys().equals(Set.of("format", "component", "state")) || !jsonString(payload, "format").equals("rezics-component-v1")
            || !jsonString(payload, "component").equals(component.getURI()) || !payload.get("state").isObject()) throw bad("sealed object descriptor differs");
        return payload.get("state").getAsObject();
    }

    private static JsonObject strictJson(String bytes) {
        // Atlas uses an extended JSON dialect and does not require EOF. Content
        // consumers use strict JSON, so validate the complete grammar first.
        class Syntax {
            int at;
            void whitespace() { while (at < bytes.length() && " \t\r\n".indexOf(bytes.charAt(at)) >= 0) at++; }
            boolean take(char ch) { whitespace(); if (at < bytes.length() && bytes.charAt(at) == ch) { at++; return true; } return false; }
            void require(char ch) { if (!take(ch)) throw bad("sealed JSON expected " + ch); }
            String stringToken() {
                whitespace(); int start = at; require('"');
                while (at < bytes.length()) {
                    char ch = bytes.charAt(at++);
                    if (ch == '"') return bytes.substring(start, at);
                    if (ch < 32) throw bad("sealed JSON raw control character");
                    if (ch == '\\') {
                        if (at == bytes.length()) throw bad("sealed JSON escape truncated");
                        char escape = bytes.charAt(at++);
                        if (escape == 'u') {
                            for (int n = 0; n < 4; n++) if (at == bytes.length() || "0123456789abcdefABCDEF".indexOf(bytes.charAt(at++)) < 0) throw bad("sealed JSON unicode escape differs");
                        } else if ("\"\\/bfnrt".indexOf(escape) < 0) throw bad("sealed JSON escape differs");
                    }
                }
                throw bad("sealed JSON string truncated");
            }
            void value(int depth) {
                whitespace(); if (depth > 16 || at == bytes.length()) throw bad("sealed JSON nesting or value differs");
                char ch = bytes.charAt(at);
                if (ch == '{') {
                    at++; Set<String> fields = new HashSet<>(); if (take('}')) return;
                    do {
                        String token = stringToken();
                        String key = JSON.parse("{" + token + ":null}").keys().iterator().next();
                        if (!fields.add(key)) throw bad("duplicate sealed JSON field");
                        require(':'); value(depth + 1);
                    } while (take(','));
                    require('}');
                } else if (ch == '[') {
                    at++; if (take(']')) return;
                    do { value(depth + 1); } while (take(',')); require(']');
                } else if (ch == '"') stringToken();
                else if (ch == 't' || ch == 'f' || ch == 'n') {
                    String literal = ch == 't' ? "true" : ch == 'f' ? "false" : "null";
                    if (!bytes.startsWith(literal, at)) throw bad("sealed JSON literal differs"); at += literal.length();
                } else {
                    var number = java.util.regex.Pattern.compile("-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?").matcher(bytes).region(at, bytes.length());
                    if (!number.lookingAt()) throw bad("sealed JSON number differs"); at = number.end();
                }
            }
        }
        try {
            utf8(bytes);
            Syntax syntax = new Syntax(); syntax.value(0); syntax.whitespace();
            if (syntax.at != bytes.length()) throw bad("sealed JSON trailing data");
            return JSON.parse(bytes);
        } catch (RuntimeException ex) { throw bad("sealed JSON is invalid: " + ex.getMessage()); }
    }
    private static String jsonString(JsonObject object, String field) {
        JsonValue value = object.get(field);
        if (value == null || !value.isString()) throw bad("sealed string field differs: " + field);
        return value.getAsString().value();
    }

    /** Leapfrog native prefix seeks skip assessments instead of filtering their component population. */
    private static Set<Node> intersection(DatasetGraph data, Node graph, List<Node[]> predicates, Counter count) {
        var storage = TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data));
        var index = (TupleIndexRecord) TDBInternal.findIndex(storage, "GPOS").baseTupleIndex();
        var factory = new RecordFactory(32, 0);
        List<byte[]> prefixes = new ArrayList<>();
        for (Node[] pair : predicates) {
            byte[] prefix = new byte[32]; Node[] terms = { graph, pair[0], pair[1] };
            for (int i = 0; i < 3; i++) {
                var id = TDBInternal.getNodeId(storage, terms[i]);
                if (org.apache.jena.tdb2.store.NodeId.isDoesNotExist(id)) return Set.of();
                NodeIdFactory.set(id, prefix, i * 8);
            }
            prefixes.add(prefix);
        }
        Set<Node> found = new HashSet<>(); byte[] lower = new byte[8];
        while (found.size() < 2) {
            byte[] greatest = lower; boolean equal = true;
            for (byte[] prefix : prefixes) {
                var start = factory.createKeyOnly(); System.arraycopy(prefix, 0, start.getKey(), 0, 24); System.arraycopy(greatest, 0, start.getKey(), 24, 8);
                var end = factory.createKeyOnly(); System.arraycopy(prefix, 0, end.getKey(), 0, 24);
                NodeIdFactory.setNext(NodeIdFactory.get(prefix, 16), end.getKey(), 16);
                var rows = index.getRangeIndex().iterator(start, end);
                byte[] subject;
                try {
                    if (!rows.hasNext()) return Set.copyOf(found);
                    if (count.seeks == MAX_SEEK_TUPLES) throw bad("native eligibility seek work exceeds fixed bound");
                    subject = Arrays.copyOfRange(rows.next().getKey(), 24, 32); count.seeks++;
                } finally { Iter.close(rows); }
                int comparison = Arrays.compareUnsigned(subject, greatest);
                if (comparison > 0) { greatest = subject; equal = false; }
            }
            if (!equal) { lower = greatest; continue; }
            byte[] key = prefixes.getFirst().clone(); System.arraycopy(greatest, 0, key, 24, 8);
            found.add(storage.getQuadTable().getNodeTupleTable().getNodeTable().getNodeForNodeId(NodeIdFactory.get(key, 24)));
            lower = greatest.clone(); increment(lower);
        }
        return Set.copyOf(found);
    }
    private static void increment(byte[] bytes) {
        for (int i = bytes.length - 1; i >= 0; i--) if (++bytes[i] != 0) return;
        throw bad("native subject range exhausted");
    }

    static String check(DatasetGraph logical, Snapshot before) {
        if (before.error() != null) return before.error();
        try {
            DatasetGraph data = TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(logical));
            Counter count = new Counter();
            for (var entry : before.expected().entrySet()) if (!stored(data, entry.getKey().graph(), entry.getKey().subject(), MAX_RECORD_QUADS, count).equals(entry.getValue())) return "Claim fold poststate differs";
            return null;
        } catch (IllegalArgumentException ex) { return ex.getMessage(); }
    }

    static String checkControl(DatasetGraph data, String receipt, CommandPolicy.Plan plan,
        CommandInvariant.Control before, CommandInvariant.Control after, Node epoch, BigInteger sequence) {
        if (before == null || after == null || !CommandInvariant.hasControlGuards(plan, before) || !before.epoch().equals(after.epoch())
            || !before.routing().equals(after.routing()) || !before.sequence().equals(after.sequence())
            || !Objects.equals(before.marker(), after.marker()) || !Objects.equals(before.priorEpoch(), after.priorEpoch())
            || !Objects.equals(before.priorSequence(), after.priorSequence()) || !Objects.equals(before.cursor(), after.cursor())
            || !Objects.equals(before.textGeneration(), after.textGeneration()) || !epoch.equals(before.epoch()) || !sequence.equals(before.sequence())) return "Claim fold changed dataset lineage or position";
        String phase = phase(receipt);
        if (phase.equals("complete") || phase.equals("release")) return "Claim fold completion and release require exhaustive reconciled inventory";
        if (phase.equals("acquire") ? before.held() || !after.held() : !before.held() || !after.held()) return "Claim fold hold transition differs";
        return null;
    }

    static CommandPolicy.Plan nativePlan(CommandPolicy.Plan plan, String receipt) {
        if (plan.current().isEmpty()) return plan;
        var modify = (UpdateModify) plan.request().getOperations().getFirst();
        Node claim = required(modify, RECEIPTS, uri(receipt), rv("convertedClaim"));
        Set<String> revisions = new HashSet<>(plan.revisions()); revisions.remove(claim.getURI());
        return new CommandPolicy.Plan(plan.request(), plan.graphs(), plan.current(), Set.copyOf(revisions), plan.source(), plan.bootstrap(), plan.rebuild(), plan.hasDelete());
    }

    /** Hide only archived Claim C while validating current Statement C and fresh B.
     * Original Claim C validates separately in the revisions graph, where R remains intact. */
    static DatasetGraph validationView(DatasetGraph data, CommandPolicy.Plan plan) {
        if (plan.current().isEmpty()) return data;
        if (plan.current().size() != 1) throw bad("one Claim validation view required");
        Node claim = uri(plan.current().iterator().next());
        class NativeView extends DatasetGraphWrapper implements DatasetGraphWrapperView {
            NativeView() { super(data); }
            @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
                return Iter.filter(super.find(graph, subject, predicate, object), quad -> !(quad.getGraph().equals(REVISIONS) && quad.getSubject().equals(claim)));
            }
            @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
                var rows = find(graph, subject, predicate, object); try { return rows.hasNext(); } finally { Iter.close(rows); }
            }
            @Override public Graph getGraph(Node graph) { return GraphView.createNamedGraph(this, graph); }
        }
        return new NativeView();
    }

    private static Set<Quad> stored(DatasetGraph data, Node graph, Node subject, int limit, Counter count) {
        Set<Quad> result = new HashSet<>(); var rows = data.find(graph, subject, Node.ANY, Node.ANY);
        try { while (rows.hasNext()) {
            if (result.size() == limit) throw bad("retained record exceeds fixed footprint");
            result.add(rows.next()); count.quads++;
        } } finally { Iter.close(rows); }
        return result;
    }
    private static void refuseDefault(DatasetGraph data, Node subject, Counter count) {
        var rows = data.find(Quad.defaultGraphNodeGenerated, subject, Node.ANY, Node.ANY);
        try { if (rows.hasNext()) { rows.next(); count.quads++; throw bad("mixed or default retained owner facts are unsupported"); } } finally { Iter.close(rows); }
    }
    private static Set<Node> predicates(Set<Quad> quads) { Set<Node> fields = new HashSet<>(); for (Quad quad : quads) fields.add(quad.getPredicate()); return fields; }
    private static Set<Node> values(Set<Quad> quads, Node predicate) {
        Set<Node> result = new HashSet<>(); for (Quad quad : quads) if (quad.getPredicate().equals(predicate)) result.add(quad.getObject()); return result;
    }
    private static Node one(Set<Quad> quads, Node predicate) { Node value = optional(quads, predicate); if (value == null) throw bad("required retained field missing: " + predicate); return value; }
    private static Node optional(Set<Quad> quads, Node predicate) {
        Set<Node> values = values(quads, predicate); if (values.size() > 1) throw bad("ambiguous retained field: " + predicate); return values.isEmpty() ? null : values.iterator().next();
    }
    private static Node required(UpdateModify modify, Node graph, Node subject, Node predicate) {
        Node value = null;
        for (Quad quad : modify.getInsertQuads()) if (quad.getGraph().equals(graph) && quad.getSubject().equals(subject) && quad.getPredicate().equals(predicate)) {
            if (value != null) throw bad("ambiguous template field: " + predicate); value = quad.getObject();
        }
        if (value == null) throw bad("required template field missing: " + predicate); return value;
    }
    private static Set<Quad> record(Node graph, Node subject, Map<Node, Node> fields) { Set<Quad> result = new HashSet<>(); fields.forEach((p, o) -> result.add(new Quad(graph, subject, p, o))); return result; }
    private static Set<Quad> quads(List<Quad> quads, Node graph) { Set<Quad> result = new HashSet<>(); for (Quad quad : quads) if (quad.getGraph().equals(graph)) result.add(quad); return result; }
    private static Set<Quad> subjectQuads(List<Quad> quads, Node graph, Node subject) { Set<Quad> result = new HashSet<>(); for (Quad quad : quads) if (quad.getGraph().equals(graph) && quad.getSubject().equals(subject)) result.add(quad); return result; }
    private static boolean positive(Element element, Node graph, Node subject, Node predicate, Node object) { return positive(element, graph, subject, predicate, object, false); }
    private static boolean positive(Element element, Node graph, Node subject, Node predicate, Node object, boolean named) {
        if (element instanceof ElementGroup group) return group.getElements().stream().anyMatch(child -> positive(child, graph, subject, predicate, object, named));
        if (element instanceof ElementNamedGraph target) return target.getGraphNameNode().equals(graph) && positive(target.getElement(), graph, subject, predicate, object, true);
        var wanted = org.apache.jena.graph.Triple.create(subject, predicate, object);
        if (named && element instanceof ElementPathBlock block) { var rows = block.patternElts(); while (rows.hasNext()) { var row = rows.next(); if (row.isTriple() && row.asTriple().equals(wanted)) return true; } }
        if (named && element instanceof ElementTriplesBlock block) { var rows = block.patternElts(); while (rows.hasNext()) if (rows.next().equals(wanted)) return true; }
        return false;
    }
    private static void reference(Node node) {
        if (node == null || !node.isURI() || node.getURI().length() > 300 || !node.getURI().matches("(?:https://[^/]+(?:/[^\\s<>\"{}|\\\\^`]+)?|urn:[^\\s<>\"{}|\\\\^`]+)")
            || node.getURI().chars().anyMatch(c -> c <= 32 || c == 127 || "<>\"{}|\\^`".indexOf(c) >= 0)) throw bad("retained IRI kind or syntax differs");
    }
    private static boolean nativeId(Node node) { return node != null && node.isURI() && node.getURI().matches("https://rezics.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}"); }
    private static boolean typed(Node node, String type) { return node != null && node.isLiteral() && node.getLiteralLanguage().isEmpty() && (XSD + type).equals(node.getLiteralDatatypeURI()); }
    private static String string(Node node) { if (!typed(node, "string")) throw bad("exact string datatype required"); return node.getLiteralLexicalForm(); }
    private static void publicationDate(Node node) {
        if (node == null || !node.isLiteral() || !node.getLiteralLanguage().isEmpty()) throw bad("publication value term differs");
        String value = node.getLiteralLexicalForm();
        try {
            if (typed(node, "date") && value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) { if (LocalDate.parse(value).getYear() < 1) throw bad("publication year differs"); return; }
            if (!typed(node, "dateTime") || !value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?")) throw bad("publication value grammar differs");
            String local = value;
            if (value.endsWith("Z")) local = value.substring(0, value.length() - 1);
            else if (value.matches(".*[+-][0-9]{2}:[0-9]{2}")) {
                String offset = value.substring(value.length() - 6); int hour = Integer.parseInt(offset.substring(1, 3)), minute = Integer.parseInt(offset.substring(4));
                if (hour > 14 || minute > 59 || hour == 14 && minute != 0) throw bad("publication offset differs"); local = value.substring(0, value.length() - 6);
            }
            if (LocalDateTime.parse(local).getYear() < 1) throw bad("publication year differs");
        } catch (java.time.DateTimeException ex) { throw bad("publication value is not Gregorian"); }
    }
    private static String canonicalInstant(Node node) {
        if (!typed(node, "dateTime") || !node.getLiteralLexicalForm().matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,3})?Z")) throw bad("UTC instant term differs");
        try { return OffsetDateTime.parse(node.getLiteralLexicalForm()).format(DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)); }
        catch (java.time.DateTimeException ex) { throw bad("UTC instant is not Gregorian"); }
    }
    private static List<Object> termIdentity(Node node) {
        if (node.isURI()) return Arrays.asList("uri", node.getURI(), null, null);
        if (node.isLiteral()) return Arrays.asList("literal", node.getLiteralLexicalForm(), node.getLiteralDatatypeURI(), node.getLiteralLanguage().isEmpty() ? null : node.getLiteralLanguage());
        throw bad("retained blank or variable term unsupported");
    }
    private static List<Object> propertyIdentity(Set<Quad> quads) {
        return quads.stream().sorted(Comparator.comparing((Quad quad) -> quad.getPredicate().getURI()).thenComparing(quad -> json(termIdentity(quad.getObject()))))
            .map(quad -> (Object) List.of(quad.getPredicate().getURI(), termIdentity(quad.getObject()))).toList();
    }
    /** The fixed hash tuples use JSON.stringify spelling, never Jena's pretty JSON writer. */
    private static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof String string) {
            StringBuilder out = new StringBuilder("\"");
            for (int i = 0; i < string.length(); i++) {
                char ch = string.charAt(i);
                switch (ch) {
                    case '"' -> out.append("\\\""); case '\\' -> out.append("\\\\");
                    case '\b' -> out.append("\\b"); case '\f' -> out.append("\\f"); case '\n' -> out.append("\\n"); case '\r' -> out.append("\\r"); case '\t' -> out.append("\\t");
                    default -> { if (ch < 32 || Character.isSurrogate(ch) && !(Character.isHighSurrogate(ch) && i + 1 < string.length() && Character.isLowSurrogate(string.charAt(i + 1))) && !(Character.isLowSurrogate(ch) && i > 0 && Character.isHighSurrogate(string.charAt(i - 1)))) out.append(String.format(Locale.ROOT, "\\u%04x", (int) ch)); else out.append(ch); }
                }
            }
            return out.append('"').toString();
        }
        if (value instanceof List<?> list) return "[" + String.join(",", list.stream().map(ClaimStatementFoldPolicy::json).toList()) + "]";
        if (value instanceof Map<?, ?> map) return "{" + String.join(",", map.entrySet().stream().map(entry -> json(entry.getKey()) + ':' + json(entry.getValue())).toList()) + "}";
        if (value instanceof Boolean || value instanceof Number) return value.toString();
        throw bad("unsupported fixed hash term");
    }
    private static Map<String, Object> map(Object... fields) { Map<String, Object> result = new LinkedHashMap<>(); for (int i = 0; i < fields.length; i += 2) result.put((String) fields[i], fields[i + 1]); return result; }
    private static byte[] utf8(String value) {
        try {
            var encoded = StandardCharsets.UTF_8.newEncoder().encode(java.nio.CharBuffer.wrap(value));
            byte[] bytes = new byte[encoded.remaining()]; encoded.get(bytes); return bytes;
        } catch (java.nio.charset.CharacterCodingException ex) { throw bad("invalid sealed UTF8 encoding"); }
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(utf8(value))); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private static Set<Node> fields(String... names) { Set<Node> fields = new HashSet<>(); for (String name : names) fields.add(rv(name)); return Set.copyOf(fields); }
    private static IllegalArgumentException bad(String message) { return new IllegalArgumentException("Claim fold " + message); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri(RV + name); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private ClaimStatementFoldPolicy() {}
}
