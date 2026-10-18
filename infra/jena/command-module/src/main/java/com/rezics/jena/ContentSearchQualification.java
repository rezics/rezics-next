package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Completeness evidence for the existing generation owner. Runs only in its
 * maintenance audit; publication/eligibility decisions remain owner records. */
final class ContentSearchQualification {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String DEFINITION = "https://rezics.com/definition/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node RECEIPTS = uri(CommandPolicy.RECEIPTS), PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node PRODUCT = uri("urn:rezics:dataset:product");
    private static final String UUID = "(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

    record Witness(long population, String ownerEpoch, BigInteger ownerSequence, boolean publicDomain) {
        Map<String, Object> envelope() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("population", Long.toString(population));
            if (ownerEpoch != null) result.put("ownerDataEpoch", ownerEpoch);
            result.put("ownerSequence", ownerSequence.toString());
            result.put("publicDomain", publicDomain);
            return Map.copyOf(result);
        }
    }
    private record Publication(BigInteger sequence, String ownerEpoch, BigInteger ownerSequence) {}
    static final class Refusal extends IllegalStateException {
        Refusal() { super("Content publication qualification is unresolved"); }
    }

    /** Observe actual owner writes, including deletions and same-position
     * revocations. Control sequence alone is not an authority fence. */
    static boolean changed(DatasetGraph data, org.apache.jena.sparql.core.Quad quad) {
        Node graph = quad.getGraph(), subject = quad.getSubject(), predicate = quad.getPredicate(), object = quad.getObject();
        if (PUBLIC.equals(graph)) return subject.isURI() && subject.getURI().startsWith("urn:rezics:content:match-unit:");
        if (CURRENT.equals(graph)) return predicate.equals(p("contentPublicationHead"))
            || predicate.equals(p("publicSearchEligibilityHead"))
            || predicate.equals(RDF.type.asNode()) && object.equals(p("ContentVariant"))
            || data.contains(CURRENT, subject, RDF.type.asNode(), p("ContentVariant"));
        if (REVISIONS.equals(graph)) {
            if (predicate.equals(RDF.type.asNode()) && object.equals(p("ErasedRevision"))) return true;
            for (String type : List.of("ContentPublicationDecision", "ContentWithdrawalDecision", "ContentSearchEligibilityDecision", "ContentProjection"))
                if (predicate.equals(RDF.type.asNode()) && object.equals(p(type))
                    || data.contains(REVISIONS, subject, RDF.type.asNode(), p(type))) return true;
        }
        if (RECEIPTS.equals(graph)) for (String link : List.of("publicationDecision", "eligibilityDecision", "projection"))
            if (predicate.equals(p(link)) || data.contains(RECEIPTS, subject, p(link), Node.ANY)) return true;
        return false;
    }

    static Witness audit(DatasetGraph data, Set<String> indexed, String epoch, BigInteger sequence, long deadline) {
        Set<Node> variants = new LinkedHashSet<>();
        for (String head : List.of("contentPublicationHead", "publicSearchEligibilityHead")) {
            var rows = data.find(CURRENT, Node.ANY, p(head), Node.ANY);
            try {
                while (rows.hasNext()) {
                    budget(deadline);
                    Node variant = rows.next().getSubject();
                    if (data.contains(CURRENT, variant, RDF.type.asNode(), p("ContentVariant"))) variants.add(variant);
                }
            } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        }
        long population = 0;
        String ownerEpoch = null;
        BigInteger ownerSequence = BigInteger.ZERO;
        boolean publicDomain = false;
        for (Node variant : variants) {
            budget(deadline);
            require(variant.isURI());
            Node resource = iri(data, CURRENT, variant, "resource");
            Node current = iri(data, CURRENT, variant, "contentPublicationHead");
            Publication publication = publication(data, current, variant, resource, epoch, sequence);
            if (ownerEpoch == null) ownerEpoch = publication.ownerEpoch();
            require(ownerEpoch.equals(publication.ownerEpoch()));
            ownerSequence = ownerSequence.max(publication.ownerSequence());
            Node eligibility = optional(data, CURRENT, variant, "publicSearchEligibilityHead");
            boolean open = false;
            if (eligibility != null) {
                require(eligibility.isURI());
                Node approved = iri(data, REVISIONS, eligibility, "publicationDecision");
                Publication prior = approved.equals(current) ? publication
                    : publication(data, approved, variant, resource, epoch, sequence);
                require(ownerEpoch.equals(prior.ownerEpoch()));
                ownerSequence = ownerSequence.max(prior.ownerSequence());
                BigInteger decisionSequence = eligibility(data, eligibility, variant, resource, epoch, sequence);
                require(decisionSequence.compareTo(prior.sequence()) > 0);
                open = approved.equals(current);
                if (!approved.equals(current)) require(prior.sequence().compareTo(publication.sequence()) < 0
                    && decisionSequence.compareTo(publication.sequence()) < 0);
                if (open && p("PublicDomain").equals(value(data, REVISIONS, eligibility, "rightsBasis"))) publicDomain = true;
            }
            int units = 0;
            var rows = data.find(PUBLIC, Node.ANY, p("variant"), variant);
            try {
                while (rows.hasNext()) {
                    budget(deadline);
                    Node unit = rows.next().getSubject();
                    if (!unit.isURI() || !unit.getURI().startsWith("urn:rezics:content:match-unit:")) continue;
                    require(open && indexed.contains(unit.getURI()) && ++units == 1
                        && current.equals(value(data, PUBLIC, unit, "publicationDecision"))
                        && eligibility.equals(value(data, PUBLIC, unit, "eligibility")));
                }
            } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            require(units == (open ? 1 : 0));
            population += units;
        }
        require(population == indexed.stream().filter(id -> id.startsWith("urn:rezics:content:match-unit:")).count());
        return new Witness(population, ownerEpoch, ownerSequence, publicDomain);
    }

    private static Publication publication(DatasetGraph data, Node decision, Node variant, Node resource,
                                           String epoch, BigInteger sequence) {
        type(data, REVISIONS, decision, "ContentPublicationDecision");
        type(data, REVISIONS, decision, "RevisionAnchor");
        require(!data.contains(REVISIONS, decision, RDF.type.asNode(), p("ErasedRevision")));
        expect(data, REVISIONS, decision, "component", variant);
        expect(data, REVISIONS, decision, "resource", resource);
        require(iri(data, REVISIONS, decision, "contentRevision").getURI().matches("urn:rezics:content:revision:" + UUID));
        require(text(data, REVISIONS, decision, "byteDigest").matches("[0-9a-f]{64}"));
        String profile = DEFINITION + "content-publication-v1";
        expect(data, REVISIONS, decision, "modelRevision", uri(profile));
        expect(data, REVISIONS, decision, "shapeRevision", uri(profile));
        expect(data, REVISIONS, decision, "datasetId", PRODUCT);
        require(text(data, REVISIONS, decision, "dataEpoch").equals(epoch));
        BigInteger graphSequence = positive(data, REVISIONS, decision, "sequence", sequence);
        String ownerEpoch = text(data, REVISIONS, decision, "ownerDataEpoch");
        require(!ownerEpoch.isEmpty() && !text(data, REVISIONS, decision, "contentPreparation").isEmpty());
        BigInteger ownerSequence = number(text(data, REVISIONS, decision, "ownerSequence"));
        Node receipt = receipt(data, decision, "publicationDecision");
        String admission = text(data, RECEIPTS, receipt, "admissionId");
        require(admission.matches(UUID));
        require(decision.getURI().equals("urn:rezics:content-publication:" + hash(admission)));
        require(receipt.getURI().equals("urn:rezics:receipt:" + hash(admission + "\0publish-content-revision")));
        require(text(data, RECEIPTS, receipt, "requestDigest").matches("[0-9a-f]{64}"));
        number(text(data, RECEIPTS, receipt, "authorityEpoch"));
        String scope = text(data, RECEIPTS, receipt, "admittedScope");
        String action = "content:publish:";
        require(scope.equals(action + variant.getURI()) || scope.equals(action + resource.getURI()));
        iri(data, RECEIPTS, receipt, "expectedHead");
        expect(data, RECEIPTS, receipt, "variant", variant);
        for (String field : List.of("resource", "contentRevision", "byteDigest", "contentPreparation", "ownerDataEpoch",
            "ownerSequence", "datasetId", "dataEpoch", "sequence")) same(data, decision, receipt, field);
        return new Publication(graphSequence, ownerEpoch, ownerSequence);
    }

    private static BigInteger eligibility(DatasetGraph data, Node decision, Node variant, Node resource,
                                           String epoch, BigInteger sequence) {
        type(data, REVISIONS, decision, "ContentSearchEligibilityDecision");
        type(data, REVISIONS, decision, "RevisionAnchor");
        expect(data, REVISIONS, decision, "component", variant);
        expect(data, REVISIONS, decision, "variant", variant);
        expect(data, REVISIONS, decision, "resource", resource);
        expect(data, REVISIONS, decision, "disclosure", p("Public"));
        Node rights = iri(data, REVISIONS, decision, "rightsBasis");
        boolean publicDomain = rights.equals(p("PublicDomain"));
        require(publicDomain || rights.equals(p("OriginalContribution")));
        String profile = "content-search-eligibility-v" + (publicDomain ? "2" : "1");
        expect(data, REVISIONS, decision, "modelRevision", uri(DEFINITION + profile));
        expect(data, REVISIONS, decision, "shapeRevision", uri(DEFINITION + profile));
        expect(data, REVISIONS, decision, "datasetId", PRODUCT);
        require(text(data, REVISIONS, decision, "dataEpoch").equals(epoch));
        BigInteger graphSequence = positive(data, REVISIONS, decision, "sequence", sequence);
        String admission = text(data, REVISIONS, decision, "admissionId");
        require(admission.matches(UUID));
        number(text(data, REVISIONS, decision, "authorityEpoch"));
        String scope = text(data, REVISIONS, decision, "admittedScope");
        require(scope.equals("content:search-eligibility:" + variant.getURI())
            || scope.equals("content:search-eligibility:" + resource.getURI()));
        Node actor = iri(data, REVISIONS, decision, "actingSubject");
        Node receipt = receipt(data, decision, "eligibilityDecision");
        require(decision.getURI().equals("urn:rezics:content-search-eligibility:" + hash(admission))
            && receipt.getURI().equals("urn:rezics:receipt:" + hash(admission + "\0content-search-eligibility")));
        for (String field : List.of("variant", "resource", "publicationDecision", "rightsBasis", "disclosure",
            "admissionId", "authorityEpoch", "admittedScope", "actingSubject", "datasetId", "dataEpoch", "sequence"))
            same(data, decision, receipt, field);
        Node assessment = optional(data, REVISIONS, decision, "rightsAssessment");
        require(java.util.Objects.equals(assessment, optional(data, RECEIPTS, receipt, "rightsAssessment")));
        require(publicDomain ? assessment != null && assessment.isURI()
            && assessment.getURI().matches("urn:rezics:rights:assessment:" + UUID) : assessment == null);
        Node expected = iri(data, RECEIPTS, receipt, "expectedHead");
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("family", profile); fields.put("resourceId", resource.getURI()); fields.put("variantId", variant.getURI());
        fields.put("publicationDecision", iri(data, REVISIONS, decision, "publicationDecision").getURI());
        fields.put("expectedEligibilityHead", expected.getURI().equals("urn:rezics:none") ? null : expected.getURI());
        fields.put("actingSubject", actor.getURI());
        String digest = text(data, RECEIPTS, receipt, "requestDigest");
        boolean matches = false;
        // These are the canonical and retained owner serialization orders in eligibility.ts.
        for (int form = 0; form < (publicDomain ? 2 : 3); form++) {
            Map<String, String> candidate = new LinkedHashMap<>(fields);
            if (form > 0) candidate.put("rightsBasis", publicDomain ? "public-domain" : "original-contribution");
            candidate.put("disclosure", "public");
            if (form == 0) candidate.put("rightsBasis", publicDomain ? "public-domain" : "original-contribution");
            if (publicDomain && form == 0) candidate.put("assessmentId", assessment.getURI().substring("urn:rezics:rights:assessment:".length()));
            if (publicDomain || form == 2) candidate.put("profile", profile);
            if (publicDomain && form == 1) candidate.put("assessmentId", assessment.getURI().substring("urn:rezics:rights:assessment:".length()));
            String json = candidate.entrySet().stream().map(entry -> quote(entry.getKey()) + ":" + quote(entry.getValue()))
                .collect(java.util.stream.Collectors.joining(",", "{", "}"));
            matches |= hash(json).equals(digest);
        }
        require(matches);
        return graphSequence;
    }

    private static String quote(String value) {
        // Identity fields are IRIs, UUIDs and fixed terms; JSON controls cannot occur.
        return value == null ? "null" : "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static Node receipt(DatasetGraph data, Node decision, String link) {
        var rows = data.find(RECEIPTS, Node.ANY, p(link), decision);
        Node receipt;
        try { require(rows.hasNext()); receipt = rows.next().getSubject(); require(!rows.hasNext() && receipt.isURI()); }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        type(data, RECEIPTS, receipt, "OperationReceipt");
        expect(data, RECEIPTS, receipt, link, decision);
        expect(data, RECEIPTS, receipt, "outcome", p("Succeeded"));
        require(optional(data, RECEIPTS, receipt, "reason") == null);
        return receipt;
    }
    private static Node optional(DatasetGraph data, Node graph, Node subject, String field) {
        var rows = data.find(graph, subject, p(field), Node.ANY);
        try { if (!rows.hasNext()) return null; Node value = rows.next().getObject(); require(!rows.hasNext()); return value; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static Node value(DatasetGraph data, Node graph, Node subject, String field) {
        Node value = optional(data, graph, subject, field); require(value != null); return value;
    }
    private static Node iri(DatasetGraph data, Node graph, Node subject, String field) {
        Node value = value(data, graph, subject, field); require(value.isURI()
            && !value.getURI().matches(".*[\\x00-\\x20<>\"{}|^`\\\\].*")); return value;
    }
    private static String text(DatasetGraph data, Node graph, Node subject, String field) {
        Node value = value(data, graph, subject, field); require(value.isLiteral()); return value.getLiteralLexicalForm();
    }
    private static void same(DatasetGraph data, Node decision, Node receipt, String field) {
        Node left = value(data, REVISIONS, decision, field), right = value(data, RECEIPTS, receipt, field);
        require(left.equals(right) || left.isLiteral() && right.isLiteral()
            && left.getLiteralLexicalForm().equals(right.getLiteralLexicalForm()));
    }
    private static void expect(DatasetGraph data, Node graph, Node subject, String field, Node expected) {
        require(expected.equals(value(data, graph, subject, field)));
    }
    private static void type(DatasetGraph data, Node graph, Node subject, String type) {
        require(data.contains(graph, subject, RDF.type.asNode(), p(type)));
    }
    private static BigInteger number(String value) { require(value.matches("(0|[1-9][0-9]*)")); return new BigInteger(value); }
    private static BigInteger positive(DatasetGraph data, Node graph, Node subject, String field, BigInteger maximum) {
        BigInteger value = number(text(data, graph, subject, field));
        require(value.signum() > 0 && value.compareTo(maximum) <= 0); return value;
    }
    private static void budget(long deadline) { require(System.nanoTime() < deadline); }
    private static void require(boolean valid) { if (!valid) throw new Refusal(); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String field) { return uri(RV + field); }
}
