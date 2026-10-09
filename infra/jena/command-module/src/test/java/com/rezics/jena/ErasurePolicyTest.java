package com.rezics.jena;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Set;
import org.junit.Test;

/** The erasure-graph receipt is admitted only as a pure marker. The string alone is not. */
public class ErasurePolicyTest {
    private static final String REVISION = "https://rezics.com/id/00000000-0000-4000-8000-0000000000e1";
    private static final String OTHER = "https://rezics.com/id/00000000-0000-4000-8000-0000000000e2";
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

    private static CommandPolicy.Plan plan(String extraInsert, String extraDelete) {
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
            """.formatted(extraDelete, REVISION, extraInsert, RECEIPT, REVISION, REVISION);
        return CommandPolicy.parse(update, RECEIPT);
    }
}
