package com.rezics.jena;

import static org.junit.Assert.*;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.sparql.core.Quad;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class ContentSearchQualificationTest {
    private static final String RV = "https://rezics.com/vocab/", DEFINITION = "https://rezics.com/definition/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node RECEIPTS = uri(CommandPolicy.RECEIPTS), PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), PRODUCT = uri("urn:rezics:dataset:product");
    private static final Node TYPE = uri("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node p(String field) { return uri(RV + field); }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception impossible) { throw new AssertionError(impossible); }
    }
    private static void put(DatasetGraph data, Node graph, Node subject, String field, Node value) {
        data.deleteAny(graph, subject, p(field), Node.ANY); data.add(graph, subject, p(field), value);
    }
    private static Node publication(DatasetGraph data, Node variant, Node resource, int sequence) {
        String admission = UUID.randomUUID().toString();
        Node decision = uri("urn:rezics:content-publication:" + hash(admission));
        Node receipt = uri("urn:rezics:receipt:" + hash(admission + "\0publish-content-revision"));
        data.add(CURRENT, variant, TYPE, p("ContentVariant"));
        put(data, CURRENT, variant, "resource", resource);
        put(data, CURRENT, variant, "contentPublicationHead", decision);
        data.add(REVISIONS, decision, TYPE, p("ContentPublicationDecision"));
        data.add(REVISIONS, decision, TYPE, p("RevisionAnchor"));
        data.add(RECEIPTS, receipt, TYPE, p("OperationReceipt"));
        put(data, REVISIONS, decision, "component", variant);
        put(data, REVISIONS, decision, "modelRevision", uri(DEFINITION + "content-publication-v1"));
        put(data, REVISIONS, decision, "shapeRevision", uri(DEFINITION + "content-publication-v1"));
        put(data, REVISIONS, decision, "resource", resource);
        put(data, REVISIONS, decision, "contentRevision", uri("urn:rezics:content:revision:" + UUID.randomUUID()));
        put(data, REVISIONS, decision, "byteDigest", text("a".repeat(64)));
        put(data, REVISIONS, decision, "contentPreparation", text(UUID.randomUUID().toString()));
        put(data, REVISIONS, decision, "ownerDataEpoch", text("content-epoch"));
        put(data, REVISIONS, decision, "ownerSequence", text(Integer.toString(sequence)));
        put(data, REVISIONS, decision, "datasetId", PRODUCT);
        put(data, REVISIONS, decision, "dataEpoch", text("epoch"));
        put(data, REVISIONS, decision, "sequence", text(Integer.toString(sequence)));
        put(data, RECEIPTS, receipt, "publicationDecision", decision);
        put(data, RECEIPTS, receipt, "variant", variant);
        put(data, RECEIPTS, receipt, "outcome", p("Succeeded"));
        put(data, RECEIPTS, receipt, "admissionId", text(admission));
        put(data, RECEIPTS, receipt, "authorityEpoch", text("0"));
        put(data, RECEIPTS, receipt, "requestDigest", text("b".repeat(64)));
        put(data, RECEIPTS, receipt, "admittedScope", text("content:publish:" + variant.getURI()));
        put(data, RECEIPTS, receipt, "expectedHead", uri("urn:rezics:none"));
        for (String field : List.of("resource", "contentRevision", "byteDigest", "contentPreparation", "ownerDataEpoch",
            "ownerSequence", "datasetId", "dataEpoch", "sequence")) {
            Node value = data.find(REVISIONS, decision, p(field), Node.ANY).next().getObject();
            put(data, RECEIPTS, receipt, field, value);
        }
        return decision;
    }
    private static Node approve(DatasetGraph data, Node variant, Node resource, Node publication,
                                 int sequence, boolean publicDomain, int form) {
        String admission = UUID.randomUUID().toString();
        Node decision = uri("urn:rezics:content-search-eligibility:" + hash(admission));
        Node receipt = uri("urn:rezics:receipt:" + hash(admission + "\0content-search-eligibility"));
        Node actor = uri("https://rezics.com/id/99999999-9999-4999-8999-999999999999");
        String profile = "content-search-eligibility-v" + (publicDomain ? "2" : "1");
        String assessment = "11111111-1111-4111-8111-111111111111";
        data.add(REVISIONS, decision, TYPE, p("ContentSearchEligibilityDecision"));
        data.add(REVISIONS, decision, TYPE, p("RevisionAnchor"));
        data.add(RECEIPTS, receipt, TYPE, p("OperationReceipt"));
        put(data, CURRENT, variant, "publicSearchEligibilityHead", decision);
        put(data, REVISIONS, decision, "component", variant);
        put(data, REVISIONS, decision, "variant", variant);
        put(data, REVISIONS, decision, "resource", resource);
        put(data, REVISIONS, decision, "publicationDecision", publication);
        put(data, REVISIONS, decision, "rightsBasis", p(publicDomain ? "PublicDomain" : "OriginalContribution"));
        put(data, REVISIONS, decision, "disclosure", p("Public"));
        put(data, REVISIONS, decision, "modelRevision", uri(DEFINITION + profile));
        put(data, REVISIONS, decision, "shapeRevision", uri(DEFINITION + profile));
        put(data, REVISIONS, decision, "admissionId", text(admission));
        put(data, REVISIONS, decision, "authorityEpoch", text("0"));
        put(data, REVISIONS, decision, "admittedScope", text("content:search-eligibility:" + variant.getURI()));
        put(data, REVISIONS, decision, "actingSubject", actor);
        put(data, REVISIONS, decision, "datasetId", PRODUCT);
        put(data, REVISIONS, decision, "dataEpoch", text("epoch"));
        put(data, REVISIONS, decision, "sequence", text(Integer.toString(sequence)));
        if (publicDomain) put(data, REVISIONS, decision, "rightsAssessment", uri("urn:rezics:rights:assessment:" + assessment));
        put(data, RECEIPTS, receipt, "eligibilityDecision", decision);
        put(data, RECEIPTS, receipt, "outcome", p("Succeeded"));
        put(data, RECEIPTS, receipt, "expectedHead", uri("urn:rezics:none"));
        for (String field : List.of("variant", "resource", "publicationDecision", "rightsBasis", "disclosure", "admissionId",
            "authorityEpoch", "admittedScope", "actingSubject", "datasetId", "dataEpoch", "sequence"))
            put(data, RECEIPTS, receipt, field, data.find(REVISIONS, decision, p(field), Node.ANY).next().getObject());
        if (publicDomain) put(data, RECEIPTS, receipt, "rightsAssessment", uri("urn:rezics:rights:assessment:" + assessment));
        String json = "{\"family\":\"" + profile + "\",\"resourceId\":\"" + resource.getURI()
            + "\",\"variantId\":\"" + variant.getURI() + "\",\"publicationDecision\":\"" + publication.getURI()
            + "\",\"expectedEligibilityHead\":null,\"actingSubject\":\"" + actor.getURI() + "\",";
        String rights = "\"rightsBasis\":\"" + (publicDomain ? "public-domain" : "original-contribution") + "\"";
        json += form == 0 ? "\"disclosure\":\"public\"," + rights : rights + ",\"disclosure\":\"public\"";
        if (publicDomain && form == 0) json += ",\"assessmentId\":\"" + assessment + "\"";
        if (publicDomain || form == 2) json += ",\"profile\":\"" + profile + "\"";
        if (publicDomain && form == 1) json += ",\"assessmentId\":\"" + assessment + "\"";
        put(data, RECEIPTS, receipt, "requestDigest", text(hash(json + "}")));
        return decision;
    }
    private static final class Fixture implements AutoCloseable {
        final DatasetGraph data = DatasetGraphFactory.createTxnMem();
        final Node variant = uri("https://rezics.com/id/11111111-1111-4111-8111-111111111111");
        final Node resource = uri("https://rezics.com/id/22222222-2222-4222-8222-222222222222");
        final Node unit = uri("urn:rezics:content:match-unit:" + "f".repeat(64));
        final Set<String> indexed = new LinkedHashSet<>();
        Fixture() { data.begin(ReadWrite.WRITE); }
        void project(Node publication, Node eligibility) {
            indexed.add(unit.getURI());
            put(data, PUBLIC, unit, "variant", variant);
            put(data, PUBLIC, unit, "publicationDecision", publication);
            put(data, PUBLIC, unit, "eligibility", eligibility);
        }
        ContentSearchQualification.Witness audit() {
            return ContentSearchQualification.audit(data, indexed, "epoch", BigInteger.valueOf(1000), Long.MAX_VALUE);
        }
        @Override public void close() { data.abort(); data.end(); data.close(); }
    }

    @Test public void qualifiesCanonicalAndRetainedOwnerDigestsWithoutAdmittingMissingCoverage() {
        for (boolean publicDomain : List.of(false, true)) for (int form = 0; form < (publicDomain ? 2 : 3); form++) {
            try (Fixture f = new Fixture()) {
                Node publication = publication(f.data, f.variant, f.resource, 1);
                Node eligibility = approve(f.data, f.variant, f.resource, publication, 2, publicDomain, form);
                assertThrows(ContentSearchQualification.Refusal.class, f::audit);
                f.project(publication, eligibility);
                assertEquals(1, f.audit().population());
                assertEquals(publicDomain, f.audit().publicDomain());
                assertEquals("content-epoch", f.audit().ownerEpoch());
            }
        }
    }
    @Test public void closedPredecessorApprovalAndLargeClosedInventoryRemainComplete() {
        try (Fixture f = new Fixture()) {
            Node first = publication(f.data, f.variant, f.resource, 1);
            approve(f.data, f.variant, f.resource, first, 2, false, 0);
            publication(f.data, f.variant, f.resource, 3);
            for (int i = 0; i < 260; i++) publication(f.data, uri("urn:variant:" + i), uri("urn:resource:" + i), i + 4);
            assertEquals(0, f.audit().population());
            assertEquals(BigInteger.valueOf(263), f.audit().ownerSequence());
        }
    }
    @Test public void damagedReceiptsAmbiguousHeadsAndStaleUnitsNeverIssueWitnesses() {
        for (String damage : List.of("receipt", "digest", "head", "missing-publication", "stale-unit", "duplicate-unit", "owner")) {
            try (Fixture f = new Fixture()) {
                Node publication = publication(f.data, f.variant, f.resource, 1);
                Node eligibility = approve(f.data, f.variant, f.resource, publication, 2, false, 0);
                f.project(publication, eligibility);
                Node receipt = f.data.find(RECEIPTS, Node.ANY, p("eligibilityDecision"), eligibility).next().getSubject();
                switch (damage) {
                    case "receipt" -> put(f.data, RECEIPTS, receipt, "outcome", p("Stale"));
                    case "digest" -> put(f.data, RECEIPTS, receipt, "requestDigest", text("c".repeat(64)));
                    case "head" -> f.data.add(CURRENT, f.variant, p("publicSearchEligibilityHead"), uri("urn:other"));
                    case "missing-publication" -> f.data.deleteAny(CURRENT, f.variant, p("contentPublicationHead"), Node.ANY);
                    case "stale-unit" -> publication(f.data, f.variant, f.resource, 3);
                    case "duplicate-unit" -> f.data.add(PUBLIC, uri("urn:rezics:content:match-unit:other"), p("variant"), f.variant);
                    case "owner" -> publication(f.data, uri("urn:variant:foreign"), uri("urn:resource:foreign"), 3);
                }
                if (damage.equals("owner")) {
                    Node second = f.data.find(CURRENT, uri("urn:variant:foreign"), p("contentPublicationHead"), Node.ANY).next().getObject();
                    Node secondReceipt = f.data.find(RECEIPTS, Node.ANY, p("publicationDecision"), second).next().getSubject();
                    put(f.data, REVISIONS, second, "ownerDataEpoch", text("foreign"));
                    put(f.data, RECEIPTS, secondReceipt, "ownerDataEpoch", text("foreign"));
                }
                assertThrows(damage, ContentSearchQualification.Refusal.class, f::audit);
            }
        }
    }
    @Test public void emptyWitnessIsExplicitAndAuthorityChangesAreObservedAfterDeletion() {
        try (Fixture f = new Fixture()) {
            assertEquals(0, f.audit().population());
            assertFalse(f.audit().envelope().containsKey("ownerDataEpoch"));
            Node publication = publication(f.data, f.variant, f.resource, 1);
            Quad head = Quad.create(CURRENT, f.variant, p("contentPublicationHead"), publication);
            f.data.delete(head);
            assertTrue(ContentSearchQualification.changed(f.data, head));
            assertTrue(ContentSearchQualification.changed(f.data, Quad.create(REVISIONS, publication, p("byteDigest"), text("x"))));
            assertFalse(ContentSearchQualification.changed(f.data, Quad.create(CONTROL, PRODUCT, p("sequence"), text("2"))));
        }
    }
    @Test public void nativeGenerationRetainsWitnessForMetadataAndWithdrawsItForAuthorityWrites() {
        EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
        definition.set("body", p("searchBody")); definition.setLangField("lang"); definition.setUidField("uid");
        TextIndexConfig config = new TextIndexConfig(definition); config.setValueStored(true);
        TextIndexLucene index = new TextIndexLucene(new ByteBuffersDirectory(), config);
        DatasetGraphText data = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), index, new TextDocProducerTriples(index));
        try {
            data.begin(ReadWrite.WRITE);
            put(data, CONTROL, PRODUCT, "dataEpoch", text("epoch")); put(data, CONTROL, PRODUCT, "routingEpoch", text("routing"));
            put(data, CONTROL, PRODUCT, "sequence", NodeFactory.createLiteralByValue(BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            put(data, CONTROL, PRODUCT, "textIndexGeneration", uri("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
            data.add(PUBLIC, uri(CommandPolicy.PUBLIC_ANCHOR), TYPE, p("SearchGraphAnchor"));
            SearchDeltaJournal.initialize(data); data.commit(); data.end();
            assertTrue(SearchDeltaJournal.qualify(data));
            assertTrue(SearchDeltaJournal.qualifiedProof(data, -1, 0).containsKey("contentQualification"));
            data.begin(ReadWrite.WRITE);
            SearchDeltaJournal.Capture metadata = new SearchDeltaJournal.Capture(data);
            metadata.observed().add(CURRENT, uri("urn:work"), p("title"), text("unrelated"));
            SearchDeltaJournal.append(data, metadata, 2); data.commit(); data.end();
            assertTrue(SearchDeltaJournal.qualifiedProof(data, -1, 2).containsKey("contentQualification"));
            data.begin(ReadWrite.WRITE);
            SearchDeltaJournal.Capture authority = new SearchDeltaJournal.Capture(data);
            authority.observed().add(CURRENT, uri("urn:variant"), p("publicSearchEligibilityHead"), uri("urn:unproven"));
            SearchDeltaJournal.append(data, authority, 4); data.commit(); data.end();
            assertEquals(true, SearchDeltaJournal.proof(data, 1, 4).get("available"));
            assertEquals(false, SearchDeltaJournal.qualifiedProof(data, -1, 4).get("available"));
            SearchDeltaJournal.stopRecovery(data);
            assertTrue(SearchDeltaJournal.qualify(data));
            // An untyped head is outside the Content inventory, as in the owner reader.
            data.begin(ReadWrite.WRITE); data.add(CURRENT, uri("urn:variant"), TYPE, p("ContentVariant")); data.commit(); data.end();
            assertTrue(SearchDeltaJournal.qualify(data));
            assertFalse(SearchDeltaJournal.qualifiedProof(data, -1, 4).containsKey("contentQualification"));
        } finally { SearchDeltaJournal.stopRecovery(data); data.close(); index.close(); }
    }
}
