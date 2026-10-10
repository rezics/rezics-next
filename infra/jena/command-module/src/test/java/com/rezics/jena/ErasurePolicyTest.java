package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Set;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** The erasure-graph receipt is admitted only as a pure marker. The string alone is not. */
public class ErasurePolicyTest {
    private static final String REVISION = "https://rezics.com/id/00000000-0000-4000-8000-0000000000e1";
    private static final String OTHER = "https://rezics.com/id/00000000-0000-4000-8000-0000000000e2";
    private static final String WORK = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a1";
    private static final String AGENT = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a2";
    private static final String REALM = "https://rezics.com/id/00000000-0000-4000-8000-0000000000a3";
    private static final String DRAFT = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b1";
    private static final String PUBLISHED = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b2";
    private static final String RELEASE = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b3";
    private static final String FIXED = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b4";
    private static final String HEAD = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b5";
    private static final String COMPOSITION = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b6";
    private static final String SEMANTIC = "https://rezics.com/id/00000000-0000-4000-8000-0000000000b7";
    private static final String CONTENT = "urn:rezics:content:revision:00000000-0000-4000-8000-0000000000c1";
    private static final String RECEIPT = "urn:rezics:receipt:erasure-graph:" + "ab".repeat(32);

    @Test public void pureMarkerIsAdmitted() {
        assertNull(ErasurePolicy.admitsMarker(plan("", ""), RECEIPT));
    }

    @Test public void receiptStringWithoutTheMarkerUpdateIsRejected() {
        CommandPolicy.Plan bare = new CommandPolicy.Plan(null, Set.of(CommandPolicy.REVISIONS),
            Set.of(), Set.of(REVISION), Set.of(), false, false, false);
        String refused = ErasurePolicy.admitsMarker(bare, RECEIPT);
        assertNotNull(refused);
        assertTrue(refused, refused.contains("not a marker"));
    }

    @Test public void extraQuadOnTheRevisionIsRejected() {
        String refused = ErasurePolicy.admitsMarker(plan("<" + REVISION + "> rv:note \"extra\" .", ""), RECEIPT);
        assertNotNull(refused);
        assertTrue(refused, refused.contains("tombstone"));
    }

    @Test public void extraQuadOnAnotherSubjectIsRejected() {
        String refused = ErasurePolicy.admitsMarker(plan("<" + OTHER + "> rv:note \"extra\" .", ""), RECEIPT);
        assertNotNull(refused);
        assertTrue(refused, refused.contains("tombstone"));
    }

    @Test public void deletedQuadIsRejected() {
        String refused = ErasurePolicy.admitsMarker(plan("",
            "GRAPH <urn:rezics:graph:revisions> { <" + REVISION + "> rv:component <" + OTHER + "> }"), RECEIPT);
        assertNotNull(refused);
        assertTrue(refused, refused.contains("owner history"));
    }

    @Test public void workAgentAndRealmIrisAreNotRevisions() {
        refuse(typed("urn:rezics:graph:current", WORK, "https://schema.org/CreativeWork"), WORK);
        refuse(typed("urn:rezics:graph:current", AGENT, "https://rezics.com/vocab/Agent"), AGENT);
        refuse(typed("urn:rezics:graph:current", REALM, "https://rezics.com/vocab/Realm"), REALM);
    }

    @Test public void markerAloneIsNotAPriorRevision() {
        refuse(typed(CommandPolicy.REVISIONS, REVISION, "https://rezics.com/vocab/ErasedRevision"), REVISION);
    }

    @Test public void contentRevisionUrnStaysABareTombstone() {
        assertNull(ErasurePolicy.preflight(DatasetGraphFactory.createTxnMem(),
            marker(CONTENT), RECEIPT));
    }

    @Test public void textContributionDraftIsARevision() {
        admit("RevisionAnchor", DRAFT);
    }

    @Test public void publishedContributionDraftIsARevision() {
        admit("RevisionAnchor", PUBLISHED);
    }

    @Test public void releaseRevisionIsARevision() {
        admit("ReleaseRevision", RELEASE);
    }

    @Test public void fixedReleaseIsARevision() {
        admit("FixedRelease", FIXED);
    }

    @Test public void workHeadIsARevision() {
        admit("RevisionAnchor", HEAD);
    }

    @Test public void compositionRevisionIsARevision() {
        admit("StructureRevision", COMPOSITION);
    }

    @Test public void semanticRevisionIsARevision() {
        admit("SemanticRevision", SEMANTIC);
    }

    private static void admit(String type, String subject) {
        assertNull(ErasurePolicy.preflight(typed(CommandPolicy.REVISIONS, subject,
            "https://rezics.com/vocab/" + type), marker(subject), RECEIPT));
    }

    private static void refuse(DatasetGraph data, String subject) {
        assertEquals("erasure target is not a revision",
            ErasurePolicy.preflight(data, marker(subject), RECEIPT));
    }

    private static DatasetGraph typed(String graph, String subject, String type) {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        data.add(NodeFactory.createURI(graph), NodeFactory.createURI(subject), RDF.type.asNode(),
            NodeFactory.createURI(type));
        return data;
    }

    private static CommandPolicy.Plan marker(String subject) {
        return plan(subject, "", "");
    }

    private static CommandPolicy.Plan plan(String extraInsert, String extraDelete) {
        return plan(REVISION, extraInsert, extraDelete);
    }

    private static CommandPolicy.Plan plan(String subject, String extraInsert, String extraDelete) {
        String update = """
            PREFIX rv: <https://rezics.com/vocab/>
            PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
            DELETE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?prior }
              GRAPH <urn:rezics:search:public> { ?unit ?p ?o }
              GRAPH <urn:rezics:search:private> { ?private ?pp ?po }
              %s
            }
            INSERT {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
              GRAPH <urn:rezics:graph:revisions> {
                <%s> a rv:ErasedRevision ; rv:erasureEpoch "7"^^xsd:integer .
                %s
              }
              GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt }
              GRAPH <urn:rezics:graph:outbox> { <urn:rezics:outbox:erasure> a rv:OutboxBatch }
            }
            WHERE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?prior }
              BIND(?prior + 1 AS ?next)
              GRAPH <urn:rezics:search:public> { ?unit rv:revision <%s> ; ?p ?o }
              GRAPH <urn:rezics:search:private> { ?private rv:revision <%s> ; ?pp ?po }
            }
            """.formatted(extraDelete, subject, extraInsert, RECEIPT, subject, subject);
        return CommandPolicy.parse(update, RECEIPT);
    }
}
