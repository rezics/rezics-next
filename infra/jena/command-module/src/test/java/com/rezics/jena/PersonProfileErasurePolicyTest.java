package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class PersonProfileErasurePolicyTest {
    static Node uri(String value) { return NodeFactory.createURI(value); }
    static Node rv(String value) { return uri("https://rezics.com/vocab/" + value); }
    static Node text(String value) { return NodeFactory.createLiteralString(value); }
    static Node integer(String value) { return NodeFactory.createLiteralDT(value, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    static String id(int value) { return "00000000-0000-4000-8000-%012d".formatted(value); }
    static Node resource(int value) { return uri("https://rezics.com/id/" + id(value)); }
    static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH), PRIVATE = uri(CommandPolicy.PRIVATE_SEARCH),
        PERSON = resource(1), OTHER = resource(2), WORK = resource(3), CREDIT = resource(4),
        ANCHOR = uri("https://rezics.com/id/" + id(5) + "-agent-revision"), PROFILE = resource(6),
        UNIT = uri("urn:rezics:search:name:agent:" + id(1)), FOREIGN_UNIT = uri("urn:rezics:search:foreign");
    static final String ERASURE_ID = id(7);
    static String receipt() throws Exception { return "urn:rezics:receipt:erasure-graph:" + ErasureRestorePolicy.hash(ERASURE_ID); }

    static DatasetGraph fixture() {
        var data = DatasetGraphFactory.createTxnMem();
        for (Node person : List.of(PERSON, OTHER)) {
            data.add(CURRENT, person, RDF.type.asNode(), rv("Agent"));
            data.add(CURRENT, person, rv("agentKind"), rv("PersonAgent"));
            data.add(CURRENT, person, rv("head"), ANCHOR);
            data.add(CURRENT, person, uri("http://www.w3.org/2000/01/rdf-schema#label"), text("Exact identifying name"));
        }
        data.add(CURRENT, WORK, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
        data.add(CURRENT, CREDIT, RDF.type.asNode(), rv("AuthorCredit"));
        data.add(CURRENT, CREDIT, rv("agent"), PERSON);
        data.add(CURRENT, CREDIT, rv("work"), WORK);
        data.add(REVISIONS, ANCHOR, RDF.type.asNode(), rv("RevisionAnchor"));
        data.add(REVISIONS, ANCHOR, rv("component"), PERSON);
        data.add(REVISIONS, ANCHOR, rv("modelRevision"), uri("https://rezics.com/definition/agent-provision-v1"));
        data.add(REVISIONS, ANCHOR, rv("operation"), uri("urn:rezics:operation:agent-provision:" + id(5)));
        data.add(REVISIONS, ANCHOR, rv("manifest"), uri("urn:rezics:sha256:" + "a".repeat(64)));
        data.add(REVISIONS, PROFILE, RDF.type.asNode(), rv("RevisionAnchor"));
        data.add(REVISIONS, PROFILE, RDF.type.asNode(), rv("AgentPublicProfileRevision"));
        data.add(REVISIONS, PROFILE, rv("component"), PERSON);
        data.add(REVISIONS, PROFILE, rv("modelRevision"), uri("https://rezics.com/definition/agent-profile-v2"));
        data.add(REVISIONS, PROFILE, rv("operation"), uri("urn:rezics:operation:agent-profile:" + id(6)));
        data.add(REVISIONS, PROFILE, rv("predecessor"), ANCHOR);
        for (Node revision : List.of(ANCHOR, PROFILE)) data.add(REVISIONS, revision, rv("profileBio"), text("Historical identifying biography"));
        data.add(PUBLIC, UNIT, RDF.type.asNode(), rv("MatchUnit"));
        data.add(PUBLIC, UNIT, rv("nameResource"), PERSON);
        data.add(PUBLIC, UNIT, rv("publicTitle"), text("Exact identifying name"));
        data.add(PUBLIC, FOREIGN_UNIT, rv("resource"), WORK);
        data.add(PUBLIC, FOREIGN_UNIT, rv("publicTitle"), text("Surviving Work"));
        // The same document IRI in another graph has a different exact owner.
        data.add(PRIVATE, UNIT, rv("resource"), WORK);
        data.add(PRIVATE, UNIT, rv("privateTitle"), text("Private Work title"));
        return data;
    }

    static String update() throws Exception {
        return """
            PREFIX rv: <https://rezics.com/vocab/>
            DELETE {
              GRAPH <%s> { <%s> ?cp ?co ; a rv:Agent }
              GRAPH <%s> { <%s> ?ap ?ao . <%s> ?pp ?po }
              GRAPH <%s> { <%s> ?up ?uo }
            } INSERT {
              GRAPH <%s> { <urn:rezics:dataset:product> rv:sequence 2 }
              GRAPH <%s> { <%s> a rv:AgentTombstone ; rv:agentKind rv:PersonAgent ; rv:erasureId "%s" ; rv:erasureEpoch 7 }
              GRAPH <%s> { <%s> a rv:ErasedRevision ; rv:erasureEpoch 7 . <%s> a rv:ErasedRevision ; rv:erasureEpoch 7 }
              GRAPH <%s> { <%s> a rv:OperationReceipt ; rv:erasureId "%s" ; rv:erasureEpoch 7 }
              GRAPH <%s> { <urn:rezics:outbox:person> a rv:OutboxBatch }
            } WHERE {
              GRAPH <%s> { <%s> a rv:Agent ; rv:agentKind rv:PersonAgent ; rv:head <%s> }
              OPTIONAL {
                { GRAPH <%s> { <%s> ?cp ?co } FILTER(?cp NOT IN (rv:agentKind, <http://www.w3.org/1999/02/22-rdf-syntax-ns#type>)) }
                UNION { GRAPH <%s> { <%s> ?ap ?ao } FILTER(?ap = rv:profileBio) }
                UNION { GRAPH <%s> { <%s> ?pp ?po } FILTER(?pp = rv:profileBio) }
                UNION { GRAPH <%s> { <%s> ?up ?uo } }
              }
            }
            """.formatted(CURRENT, PERSON, REVISIONS, ANCHOR, PROFILE, PUBLIC, UNIT,
                CommandPolicy.CONTROL, CURRENT, PERSON, ERASURE_ID, REVISIONS, ANCHOR, PROFILE,
                CommandPolicy.RECEIPTS, receipt(), ERASURE_ID, CommandPolicy.OUTBOX,
                CURRENT, PERSON, ANCHOR, CURRENT, PERSON, REVISIONS, ANCHOR, REVISIONS, PROFILE, PUBLIC, UNIT);
    }
    static Set<Quad> snapshot(DatasetGraph data) { var result = new HashSet<Quad>(); data.find().forEachRemaining(result::add); return result; }
    private static String preflight(DatasetGraph data, String update) throws Exception {
        return ErasurePolicy.preflight(data, CommandPolicy.parse(update, receipt()), receipt());
    }
    private static void replace(DatasetGraph data, Node graph, Node subject, Node predicate, Node value) {
        data.deleteAny(graph, subject, predicate, Node.ANY); data.add(graph, subject, predicate, value);
    }
    private static void refused(DatasetGraph data) throws Exception {
        Set<Quad> before = snapshot(data);
        assertNotNull(preflight(data, update())); assertEquals(before, snapshot(data));
    }

    @Test public void typedPersonErasureRetainsIdentityHistoryAttributionAndUnrelatedDocuments() throws Exception {
        var data = fixture(); var plan = CommandPolicy.parse(update(), receipt()); var before = snapshot(data);
        assertNull(ErasurePolicy.admitsMarker(plan, receipt())); assertNull(ErasurePolicy.preflight(data, plan, receipt()));
        assertEquals("native preflight is read-only", before, snapshot(data));
        UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
        assertNull(ErasurePolicy.check(data, plan));
        assertTrue(ErasurePolicy.personTombstone(data, plan, receipt(), PERSON.getURI()));
        assertFalse(data.contains(PUBLIC, UNIT, Node.ANY, Node.ANY));
        assertTrue(data.contains(PRIVATE, UNIT, rv("resource"), WORK));
        assertTrue(data.contains(CURRENT, OTHER, rv("head"), ANCHOR));
        assertTrue(data.contains(CURRENT, CREDIT, rv("agent"), PERSON));
        assertTrue(data.contains(REVISIONS, PROFILE, rv("predecessor"), ANCHOR));
        assertTrue(data.contains(REVISIONS, ANCHOR, rv("manifest"), Node.ANY));
        assertFalse(data.contains(REVISIONS, Node.ANY, rv("profileBio"), Node.ANY));
        assertNull(CanonicalPolicy.validate(ProfileRegistry.load(Path.of("profiles")), data, PERSON.getURI(), false));
    }
    @Test public void wrongKindAndOrganizationAreRefused() throws Exception {
        var data = fixture(); replace(data, CURRENT, PERSON, rv("agentKind"), rv("OrganizationAgent")); refused(data);
        data = fixture(); replace(data, REVISIONS, PROFILE, RDF.type.asNode(), rv("WorkMetadataRevision")); refused(data);
        data = fixture(); data.add(CURRENT, PERSON, RDF.type.asNode(), uri("https://schema.org/CreativeWork")); refused(data);
    }
    @Test public void anotherPersonOrSharedRevisionCannotSupplyTheFootprint() throws Exception {
        var data = fixture(); replace(data, REVISIONS, ANCHOR, rv("component"), OTHER); refused(data);
        data = fixture(); data.add(REVISIONS, PROFILE, rv("component"), OTHER); refused(data);
    }
    @Test public void suffixedAnchorNeedsExactProvisioningOperationModelAndManifest() throws Exception {
        var data = fixture(); replace(data, REVISIONS, ANCHOR, rv("operation"), uri("urn:rezics:operation:agent-provision:" + id(8))); refused(data);
        data = fixture(); replace(data, REVISIONS, ANCHOR, rv("modelRevision"), uri("https://rezics.com/definition/agent-profile-v2")); refused(data);
        data = fixture(); data.deleteAny(REVISIONS, ANCHOR, rv("manifest"), Node.ANY); refused(data);
        data = fixture(); data.add(REVISIONS, ANCHOR, RDF.type.asNode(), rv("AgentPublicProfileRevision")); refused(data);
    }
    @Test public void foreignOrMixedSearchUnitIsRefused() throws Exception {
        var data = fixture(); assertNotNull(preflight(data, update().replace(UNIT.getURI(), FOREIGN_UNIT.getURI())));
        data = fixture(); data.add(PUBLIC, UNIT, rv("resource"), WORK); refused(data);
    }
    @Test public void unsealedHistoricalRevisionAndFreshIndexCopyRefuseBeforeMutation() throws Exception {
        var data = fixture(); data.add(REVISIONS, resource(9), rv("component"), PERSON); refused(data);
        data = fixture(); data.add(PUBLIC, FOREIGN_UNIT, rv("nameResource"), PERSON); refused(data);
    }
    @Test public void concreteAndVariableOwnerMetadataDeletionAreRefused() throws Exception {
        var data = fixture(); String deletion = update().replace("?ap ?ao .", "rv:component <" + PERSON + "> ; ?ap ?ao .");
        assertNotNull(preflight(data, deletion));
        assertNotNull(preflight(data, update().replace("FILTER(?ap = rv:profileBio)", "FILTER(?ap IN (rv:profileBio, rv:component))")));
    }
    @Test public void holdUnsupportedCurrentFactStaleEpochAndUnmatchedHeadAreRefused() throws Exception {
        var data = fixture(); data.add(CURRENT, PERSON, rv("protectionHead"), resource(10)); refused(data);
        data = fixture(); data.add(CURRENT, PERSON, rv("unsupportedFact"), text("retained")); refused(data);
        data = fixture(); data.add(REVISIONS, PROFILE, ERASURE_EPOCH(), integer("6")); refused(data);
        assertNotNull(preflight(fixture(), update().replace("rv:head <" + ANCHOR + ">", "rv:head <" + PROFILE + ">")));
    }
    private static Node ERASURE_EPOCH() { return rv("erasureEpoch"); }
    @Test public void wrongReceiptIdEpochAndIdentifyingTombstoneFieldsAreRefused() throws Exception {
        assertNotNull(preflight(fixture(), update().replace(ERASURE_ID, id(8))));
        assertNotNull(preflight(fixture(), update().replace("rv:erasureEpoch 7", "rv:erasureEpoch 0")));
        assertNotNull(preflight(fixture(), update().replace("rv:erasureId", "rv:profileBio")));
    }
    @Test public void compensationKeepsItsSeparateMeaning() {
        String receipt = "urn:rezics:receipt:agent-compensation:" + id(5);
        var plan = CommandPolicy.parse("PREFIX rv: <https://rezics.com/vocab/> DELETE { } INSERT { GRAPH <"
            + CURRENT + "> { <" + PERSON + "> a rv:AgentTombstone ; rv:compensatedFrom <urn:rezics:receipt:agent-provision:"
            + id(5) + "> } GRAPH <" + CommandPolicy.RECEIPTS + "> { <" + receipt + "> a rv:OperationReceipt } } WHERE { }", receipt);
        assertNull("Person erasure must not reinterpret an Agent compensation", ErasurePolicy.check(fixture(), plan));
    }
    @Test public void laterCommandsCannotRestoreTheErasedPersonProfileOrIndexReferences() throws Exception {
        var data = fixture(); UpdateAction.parseExecute(update(), DatasetFactory.wrap(data));
        String receipt = "urn:rezics:receipt:profile-replant";
        for (String inserted : List.of("GRAPH <" + CURRENT + "> { <" + PERSON + "> rv:profileBio \"replant\" }",
            "GRAPH <" + CURRENT + "> { <" + WORK + "> rv:note \"index turn\" } GRAPH <" + PUBLIC + "> { <urn:rezics:search:replant> rv:nameResource <" + PERSON + "> }")) {
            var plan = CommandPolicy.parse("PREFIX rv: <https://rezics.com/vocab/> DELETE { } INSERT { " + inserted
                + " GRAPH <" + CommandPolicy.RECEIPTS + "> { <" + receipt + "> a rv:OperationReceipt } } WHERE { }", receipt);
            assertNotNull(ErasurePolicy.preflight(data, plan, receipt));
        }
    }
    @Test public void dynamicIndexReferenceRefusesTheErasedPersonAndAllowsTheUnrelatedWork() throws Exception {
        var data = fixture(); UpdateAction.parseExecute(update(), DatasetFactory.wrap(data));
        String receipt = "urn:rezics:receipt:dynamic-profile-index";
        String template = "PREFIX rv: <https://rezics.com/vocab/> DELETE { } INSERT { GRAPH <" + CURRENT
            + "> { <" + WORK + "> rv:note \"index turn\" } GRAPH <" + PUBLIC
            + "> { <urn:rezics:search:dynamic> ?reference ?target } GRAPH <" + CommandPolicy.RECEIPTS
            + "> { <" + receipt + "> a rv:OperationReceipt } } WHERE { BIND(rv:nameResource AS ?reference) BIND(<%s> AS ?target) }";
        assertNotNull(ErasurePolicy.preflight(data, CommandPolicy.parse(template.formatted(PERSON), receipt), receipt));
        assertNull(ErasurePolicy.preflight(data, CommandPolicy.parse(template.formatted(WORK), receipt), receipt));
    }
    @Test public void productionSha256ProfileOperationsRemainTypedErasureTargets() throws Exception {
        var data = fixture();
        replace(data, REVISIONS, PROFILE, rv("operation"), uri("urn:rezics:operation:agent-profile:" + "ab".repeat(32)));
        assertNull(preflight(data, update()));
        for (String suffix : List.of("ab".repeat(31), "AB".repeat(32), "ab".repeat(32) + "x")) {
            replace(data, REVISIONS, PROFILE, rv("operation"), uri("urn:rezics:operation:agent-profile:" + suffix));
            refused(data);
        }
    }

    static final Node SOLO_PREFIX = uri("urn:rezics:search:directory:prefix:solo"),
        SHARED_PREFIX = uri("urn:rezics:search:directory:prefix:shared");
    static void authorPrefixes(DatasetGraph data) {
        for (Node entry : List.of(SOLO_PREFIX, SHARED_PREFIX)) {
            data.add(PUBLIC, entry, rv("prefixAuthor"), PERSON);
            data.add(PUBLIC, entry, rv("prefixField"), text("credit"));
            data.add(PUBLIC, entry, rv("prefixWork"), WORK);
            data.add(PUBLIC, entry, rv("publicTitle"), text("rezicsprefixdirectory"));
        }
        data.add(PUBLIC, SHARED_PREFIX, rv("prefixAuthor"), OTHER);
    }
    private static String prefixUpdate(boolean removeSharedFacts) throws Exception {
        String extraDelete = " . <" + SOLO_PREFIX + "> ?sp ?so . <" + SHARED_PREFIX + "> "
            + (removeSharedFacts ? "?shp ?sho" : "rv:prefixAuthor <" + PERSON + ">");
        String raw = update(); int split = raw.indexOf("} INSERT {");
        return raw.substring(0, split).replace("<" + UNIT + "> ?up ?uo }", "<" + UNIT + "> ?up ?uo" + extraDelete + " }")
            + raw.substring(split).replace("UNION { GRAPH <" + PUBLIC + "> { <" + UNIT + "> ?up ?uo } }",
                "UNION { GRAPH <" + PUBLIC + "> { <" + UNIT + "> ?up ?uo } } "
                + "UNION { GRAPH <" + PUBLIC + "> { <" + SOLO_PREFIX + "> ?sp ?so } } "
                + (removeSharedFacts ? "UNION { GRAPH <" + PUBLIC + "> { <" + SHARED_PREFIX + "> ?shp ?sho } }" : ""));
    }
    @Test public void personErasureRemovesAuthorPrefixesAndPreservesSharedWorkData() throws Exception {
        var data = fixture(); authorPrefixes(data);
        String update = prefixUpdate(false);
        var plan = CommandPolicy.parse(update, receipt());
        assertNull(ErasurePolicy.preflight(data, plan, receipt()));
        UpdateAction.execute(plan.request(), DatasetFactory.wrap(data));
        assertNull(ErasurePolicy.check(data, plan));
        assertFalse(data.contains(PUBLIC, SOLO_PREFIX, Node.ANY, Node.ANY));
        assertFalse(data.contains(PUBLIC, SHARED_PREFIX, rv("prefixAuthor"), PERSON));
        assertTrue(data.contains(PUBLIC, SHARED_PREFIX, rv("prefixAuthor"), OTHER));
        assertTrue(data.contains(PUBLIC, SHARED_PREFIX, rv("prefixWork"), WORK));
        assertTrue(data.contains(PUBLIC, FOREIGN_UNIT, rv("publicTitle"), text("Surviving Work")));
        assertTrue(data.contains(CURRENT, CREDIT, rv("agent"), PERSON));
    }
    @Test public void omittedAuthorPrefixesAndDeletingACoauthorsSharedEntryAreRefused() throws Exception {
        var data = fixture(); authorPrefixes(data);
        assertNotNull(preflight(data, update()));
        assertNotNull(preflight(data, prefixUpdate(true)));
        assertTrue(data.contains(PUBLIC, SHARED_PREFIX, rv("prefixAuthor"), OTHER));
    }

}
