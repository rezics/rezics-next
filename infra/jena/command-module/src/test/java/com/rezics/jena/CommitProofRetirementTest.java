package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class CommitProofRetirementTest {
    private static CommandService.Retirement evidence(String payload, String sequence, boolean signed) throws Exception {
        var evidence = new CommandService.Retirement(SlimCommandTest.RECEIPT, SlimCommandTest.DIGEST, payload, "test", sequence, "");
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec("3".repeat(64).getBytes(StandardCharsets.US_ASCII), "HmacSHA256"));
        return new CommandService.Retirement(evidence.receipt(), evidence.digest(), evidence.payloadSha256(), evidence.dataEpoch(),
            evidence.sequence(), signed ? HexFormat.of().formatHex(mac.doFinal(CommandService.retirementPayload(evidence).getBytes(StandardCharsets.UTF_8))) : "0".repeat(64));
    }
    @Test public void retirementRequiresOwnerSignatureAndExactReconciledTupleAndIsIdempotent() throws Exception {
        var profiles = SlimCommandTest.profiles(); var service = SlimCommandTest.service(profiles); var data = SlimCommandTest.dataset();
        try {
            assertEquals("committed", SlimCommandTest.run(service, data, profiles, SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 0).get("status"));
            assertEquals("invalid", service.retireProof(data, evidence(SlimCommandTest.PAYLOAD, "1", false)).get("status"));
            assertEquals("invalid", service.retireProof(data, evidence("malformed", "1", true)).get("status"));
            assertEquals("conflict", service.retireProof(data, evidence("e".repeat(64), "1", true)).get("status"));
            assertEquals("conflict", service.retireProof(data, evidence(SlimCommandTest.PAYLOAD, "2", true)).get("status"));
            data.begin(ReadWrite.READ); assertNotNull(CommandInvariant.commitProof(data, SlimCommandTest.RECEIPT)); data.end();
            assertEquals("retired", service.retireProof(data, evidence(SlimCommandTest.PAYLOAD, "1", true)).get("status"));
            assertEquals("retired", service.retireProof(data, evidence(SlimCommandTest.PAYLOAD, "1", true)).get("status"));
            data.begin(ReadWrite.READ); assertNull(CommandInvariant.commitProof(data, SlimCommandTest.RECEIPT)); data.end();
        } finally { data.close(); }
    }
    @Test public void ownerSignatureUsesTheSameCompactJsonTupleAsTheTypeScriptSigner() {
        var evidence = new CommandService.Retirement("urn:test:receipt", "a".repeat(64), "b".repeat(64), "test", "1", "");
        assertEquals("[\"rezics-commit-proof-retirement-v1\",\"urn:test:receipt\",\"" + "a".repeat(64) + "\",\"" + "b".repeat(64) + "\",\"test\",\"1\"]",
            CommandService.retirementPayload(evidence));
    }
    @Test public void anotherSignatureDomainCannotAuthorizeProofRetirement() throws Exception {
        var profiles = SlimCommandTest.profiles(); var service = SlimCommandTest.service(profiles); var data = SlimCommandTest.dataset();
        try {
            assertEquals("committed", SlimCommandTest.run(service, data, profiles, SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 0).get("status"));
            var valid = evidence(SlimCommandTest.PAYLOAD, "1", true);
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec("3".repeat(64).getBytes(StandardCharsets.US_ASCII), "HmacSHA256"));
            String otherDomain = CommandService.retirementPayload(valid).replace("rezics-commit-proof-retirement-v1", "rezics-title-admission-v1");
            var forged = new CommandService.Retirement(valid.receipt(), valid.digest(), valid.payloadSha256(), valid.dataEpoch(), valid.sequence(),
                HexFormat.of().formatHex(mac.doFinal(otherDomain.getBytes(StandardCharsets.UTF_8))));
            assertEquals("invalid", service.retireProof(data, forged).get("status"));
            data.begin(ReadWrite.READ); assertNotNull(CommandInvariant.commitProof(data, SlimCommandTest.RECEIPT)); data.end();
        } finally { data.close(); }
    }
    @Test public void interruptedRetirementRollsBackBeforeIdempotentRecovery() throws Exception {
        var profiles = SlimCommandTest.profiles(); var service = SlimCommandTest.service(profiles);
        var data = new org.apache.jena.sparql.core.DatasetGraphWrapper(SlimCommandTest.dataset()) {
            boolean interrupt = true;
            @Override public void deleteAny(org.apache.jena.graph.Node graph, org.apache.jena.graph.Node subject,
                org.apache.jena.graph.Node predicate, org.apache.jena.graph.Node object) {
                super.deleteAny(graph, subject, predicate, object);
                if (interrupt && graph.equals(SlimCommandTest.uri(CommandPolicy.RECEIPTS))
                    && subject.equals(SlimCommandTest.uri(SlimCommandTest.RECEIPT))) {
                    interrupt = false; throw new IllegalStateException("interrupted retirement");
                }
            }
        };
        try {
            assertEquals("committed", SlimCommandTest.run(service, data, profiles, SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 0).get("status"));
            var signed = evidence(SlimCommandTest.PAYLOAD, "1", true);
            assertThrows(IllegalStateException.class, () -> service.retireProof(data, signed));
            data.begin(ReadWrite.READ);
            assertNotNull(CommandInvariant.commitProof(data, SlimCommandTest.RECEIPT));
            assertEquals("1", CommandInvariant.readControl(data).sequence().toString()); data.end();
            assertEquals("retired", service.retireProof(data, signed).get("status"));
        } finally { data.close(); }
    }
    @Test public void restoreHoldRetainsProofEvenWithValidOwnerReconciliation() throws Exception {
        var profiles = SlimCommandTest.profiles(); var service = SlimCommandTest.service(profiles); var data = SlimCommandTest.dataset();
        try {
            assertEquals("committed", SlimCommandTest.run(service, data, profiles, SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 0).get("status"));
            data.begin(ReadWrite.WRITE);
            data.add(SlimCommandTest.uri(CommandPolicy.CONTROL), SlimCommandTest.uri("urn:rezics:dataset:product"),
                SlimCommandTest.rv("restoreHold"), NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
            data.commit(); data.end();
            var held = service.retireProof(data, evidence(SlimCommandTest.PAYLOAD, "1", true));
            assertEquals("invalid", held.get("status"));
            assertTrue(held.get("report").toString().contains("restore hold"));
            data.begin(ReadWrite.READ); assertNotNull(CommandInvariant.commitProof(data, SlimCommandTest.RECEIPT)); data.end();
        } finally { data.close(); }
    }
    @Test public void receiptOnlyRetirementMaintainsActualTextCommitDeltaQualification() throws Exception {
        var profiles = SlimCommandTest.profiles(); var service = SlimCommandTest.service(profiles);
        EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
        definition.set("body", SlimCommandTest.rv("searchBody"));
        definition.setLangField("lang"); definition.setUidField("uid");
        TextIndexConfig config = new TextIndexConfig(definition); config.setValueStored(true);
        var index = new TextIndexLucene(new ByteBuffersDirectory(), config);
        var data = new DatasetGraphText(SlimCommandTest.dataset(), index, new TextDocProducerTriples(index));
        try {
            data.begin(ReadWrite.WRITE);
            data.add(SlimCommandTest.uri(CommandPolicy.CONTROL), SlimCommandTest.uri("urn:rezics:dataset:product"),
                SlimCommandTest.rv("textIndexGeneration"), SlimCommandTest.uri("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
            data.add(SlimCommandTest.uri(CommandPolicy.PUBLIC_SEARCH), SlimCommandTest.uri(CommandPolicy.PUBLIC_ANCHOR),
                org.apache.jena.vocabulary.RDF.type.asNode(), SlimCommandTest.rv("SearchGraphAnchor"));
            SearchDeltaJournal.initialize(data); data.commit(); data.end();
            assertTrue(SearchDeltaJournal.qualify(data));
            assertEquals("committed", SlimCommandTest.run(service, data, profiles, SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 0).get("status"));
            assertEquals(true, SearchDeltaJournal.qualifiedProof(data, -1, 2).get("available"));
            assertEquals("retired", service.retireProof(data, evidence(SlimCommandTest.PAYLOAD, "1", true)).get("status"));
            var proof = SearchDeltaJournal.qualifiedProof(data, 1, 4);
            assertEquals(proof.toString(), true, proof.get("available"));
            assertEquals("2", proof.get("ordinal"));
            data.begin(ReadWrite.READ);
            assertEquals("1", CommandInvariant.readControl(data).sequence().toString());
            assertNull(CommandInvariant.commitProof(data, SlimCommandTest.RECEIPT));
            data.end();
        } finally { SearchDeltaJournal.stopRecovery(data); data.close(); index.close(); }
    }
    @Test public void ordinarySparqlCannotDeleteReceiptsOrCommitProofs() {
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse("""
            PREFIX rv: <https://rezics.com/vocab/>
            DELETE { GRAPH <urn:rezics:graph:receipts> { <urn:rezics:receipt:slim-metadata> ?p ?o } }
            INSERT { GRAPH <urn:rezics:graph:receipts> { <urn:rezics:receipt:slim-metadata> rv:requestDigest "replacement" } }
            WHERE { GRAPH <urn:rezics:graph:receipts> { <urn:rezics:receipt:slim-metadata> ?p ?o } }
            """, SlimCommandTest.RECEIPT));
    }
}
