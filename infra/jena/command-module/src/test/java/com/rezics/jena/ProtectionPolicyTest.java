package com.rezics.jena;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertNotNull;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.update.UpdateAction;
import org.junit.Test;
import org.apache.jena.vocabulary.RDF;

public class ProtectionPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String WORK = "https://rezics.com/id/00000000-0000-4000-8000-000000000001";
    private static final String PROTECTION = "https://rezics.com/id/00000000-0000-4000-8000-000000000002";
    private static final String RECEIPT = "urn:rezics:receipt:protection-test";
    private static final String HEAD = "https://rezics.com/id/00000000-0000-4000-8000-000000000003";
    private static final String CANDIDATE = "https://rezics.com/id/00000000-0000-4000-8000-000000000004";
    private static final String CONTROL = "https://rezics.com/id/00000000-0000-4000-8000-000000000005";
    private static final String PROPOSAL = "https://rezics.com/id/00000000-0000-4000-8000-000000000006";
    private static final byte[] KEY = new byte[32];

    private static String iri(String value) { return "<" + value + ">"; }
    private static String edit(String action) {
        return "PREFIX rv: <" + RV + "> DELETE { GRAPH " + iri(CommandPolicy.CURRENT) + " { "
            + iri(WORK) + " <http://www.w3.org/2000/01/rdf-schema#label> ?old } } "
            + "INSERT { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK)
            + " <http://www.w3.org/2000/01/rdf-schema#label> \"changed\"@en } "
            + "GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
            + " rv:outcome rv:Succeeded ; rv:action \"" + action + "\" } } "
            + "WHERE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK)
            + " <http://www.w3.org/2000/01/rdf-schema#label> ?old } }";
    }
    private static ProtectionPolicy.Snapshot capture(String mode, String action) {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                NodeFactory.createURI(RV + "protectionHead"), NodeFactory.createURI(PROTECTION));
            data.add(NodeFactory.createURI(CommandPolicy.REVISIONS), NodeFactory.createURI(PROTECTION),
                NodeFactory.createURI(RV + "protectionMode"), NodeFactory.createURI(RV + mode));
            String update = edit(action);
            return ProtectionPolicy.capture(data, CommandPolicy.parse(update, RECEIPT), RECEIPT,
                "digest", update, null, new byte[32]);
        } finally { data.abort(); data.end(); data.close(); }
    }

    @Test public void protectedMutationCannotBorrowAnOrdinaryEditReceipt() {
        assertEquals("protected Work mutation requires a reviewed protection action",
            capture("ReviewRequired", "work.edit").error());
        assertNull(capture("Open", "work.edit"));
    }

    @Test public void reviewedActionRequiresAnExactSignedEffect() {
        assertNotNull(capture("ReviewRequired", "work.correction.review").error());
    }

    @Test public void pollProposalHeadDoesNotEnterWorkProtectionPolicy() {
        for (String type : new String[] { RV + "Poll", "https://schema.org/CreativeWork" }) {
            DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
            data.begin(org.apache.jena.query.ReadWrite.WRITE);
            try {
                data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                    RDF.type.asNode(), NodeFactory.createURI(type));
                String update = "PREFIX rv: <" + RV + "> INSERT { GRAPH " + iri(CommandPolicy.CURRENT)
                    + " { " + iri(WORK) + " rv:proposalHead " + iri(PROTECTION) + " } "
                    + "GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
                    + " rv:outcome rv:Succeeded ; rv:action \"governance.poll.administer\" } } WHERE {}";
                ProtectionPolicy.Snapshot result = ProtectionPolicy.capture(data,
                    CommandPolicy.parse(update, RECEIPT), RECEIPT, "digest", update, null, new byte[32]);
                if (type.equals(RV + "Poll")) assertNull(result);
                else assertEquals("protected Work mutation requires a reviewed protection action", result.error());
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void g512ReviewedTitleLanguageMustMatchTheRetainedProposal() {
        for (String language : new String[] { "ja", "zh-Hant", "ar", "und" }) {
            var intent = new org.apache.jena.atlas.json.JsonObject();
            intent.put("titleLanguage", language);
            org.junit.Assert.assertTrue(ProtectionPolicy.matchesTitleLanguage(intent,
                NodeFactory.createLiteralLang("a title", language)));
            org.junit.Assert.assertFalse(ProtectionPolicy.matchesTitleLanguage(intent,
                NodeFactory.createLiteralLang("a title", "en")));
        }
        var legacy = new org.apache.jena.atlas.json.JsonObject();
        org.junit.Assert.assertTrue(ProtectionPolicy.matchesTitleLanguage(legacy,
            NodeFactory.createLiteralLang("legacy title", "en")));
        org.junit.Assert.assertFalse(ProtectionPolicy.matchesTitleLanguage(legacy,
            NodeFactory.createLiteralLang("legacy title", "ja")));
        legacy.put("titleLanguage", "ja--JP");
        org.junit.Assert.assertFalse(ProtectionPolicy.matchesTitleLanguage(legacy,
            NodeFactory.createLiteralLang("invalid", "ja")));
    }

    private static String sha(String value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
    private static String literal(String value) {
        return org.apache.jena.riot.out.NodeFmtLib.strNT(NodeFactory.createLiteralString(value));
    }
    private static void add(DatasetGraph data, String graph, String subject, String predicate, Node object) {
        data.add(NodeFactory.createURI(graph), NodeFactory.createURI(subject), NodeFactory.createURI(predicate), object);
    }
    private static void link(DatasetGraph data, String graph, String subject, String predicate, String object) {
        add(data, graph, subject, predicate, NodeFactory.createURI(object));
    }

    /** Execute and commit the signed SPARQL transition, including the module's canonical control validation. */
    private static String protectedTransaction(boolean review, String language, String stored, boolean unsigned) throws Exception {
        DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        data.begin(ReadWrite.WRITE);
        boolean committed = false;
        try {
            link(data, CommandPolicy.CURRENT, WORK, RDF.type.getURI(), "https://schema.org/CreativeWork");
            link(data, CommandPolicy.CURRENT, WORK, RV + "head", HEAD);
            link(data, CommandPolicy.REVISIONS, HEAD, RDF.type.getURI(), RV + "RevisionAnchor");
            add(data, CommandPolicy.CURRENT, WORK, "http://www.w3.org/2000/01/rdf-schema#label",
                NodeFactory.createLiteralLang("元の名前", language));
            link(data, CommandPolicy.REVISIONS, CANDIDATE, RDF.type.getURI(), RV + "RevisionAnchor");
            JsonObject intent = new JsonObject(); intent.put("title", "訂正した名前"); intent.put("titleLanguage", language);
            String decision = "urn:rezics:correction-decision:" + sha(PROPOSAL);
            String application = "urn:rezics:correction-application:" + sha(PROPOSAL);
            if (review) {
                link(data, CommandPolicy.CURRENT, WORK, RV + "protectionHead", PROTECTION);
                link(data, CommandPolicy.REVISIONS, PROTECTION, RV + "protectionMode", RV + "ReviewRequired");
                link(data, CommandPolicy.REVISIONS, PROPOSAL, RDF.type.getURI(), RV + "CorrectionProposal");
                link(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "component", WORK);
                link(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "baseRevision", HEAD);
                link(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "baseProtection", PROTECTION);
                link(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "baseControl", RV + "Absent");
                link(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "candidateRevision", CANDIDATE);
                add(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "candidateDigest", NodeFactory.createLiteralString("candidate"));
                add(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "proposalAdmission", NodeFactory.createLiteralString("proposer"));
                add(data, CommandPolicy.REVISIONS, PROPOSAL, RV + "proposalIntent", NodeFactory.createLiteralString(intent.toString()));
            } else {
                // A confirmation leaves the title untouched; the declared control must agree with it.
                intent.put("titleLanguage", stored);
            }
            String action = review ? "work.correction.review" : "work.protection.confirm";
            String scope = (review ? "work:review:" : "work:protect:") + WORK;
            String update = "PREFIX rv: <" + RV + "> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> "
                + (review ? "DELETE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK)
                    + " rv:head " + iri(HEAD) + "; rdfs:label ?old } } " : "")
                + "INSERT { GRAPH " + iri(CommandPolicy.CONTROL) + " { <urn:rezics:dataset:product> rv:sequence 1 } "
                + "GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK) + " rv:titleControlHead " + iri(CONTROL)
                + (review ? "; rv:head " + iri(CANDIDATE) + "; rdfs:label \"訂正した名前\"@" + stored
                    : "; rv:protectionHead " + iri(PROTECTION)) + " } "
                + "GRAPH " + iri(CommandPolicy.REVISIONS) + " { " + iri(CONTROL)
                + " a rv:RevisionAnchor, rv:EditorialControlRevision; rv:component " + iri(WORK)
                + "; rv:workRevision " + iri(review ? CANDIDATE : HEAD)
                + "; rv:controlField \"title\"; rv:controlLanguage " + literal(review ? language : stored)
                + "; rv:controlMode rv:HumanControlled; rv:controlEpoch 1; rv:controlIntent " + literal(intent.toString())
                + "; rv:operation <urn:rezics:operation:protection-test>; rv:manifest <urn:rezics:sha256:protection-test>; "
                + "rv:modelRevision <https://rezics.com/definition/work-title-control-v2>; "
                + "rv:shapeRevision <https://rezics.com/definition/work-title-control-v2>; rv:dataEpoch \"epoch\"; rv:sequence 1 . "
                + (review ? iri(decision) + " a rv:CorrectionDecision; rv:proposalRevision " + iri(PROPOSAL)
                    + "; rv:outcome rv:Accepted; rv:candidateDigest \"candidate\" . "
                    + iri(application) + " a rv:CorrectionApplication; rv:proposalRevision " + iri(PROPOSAL)
                    + "; rv:decision " + iri(decision) + "; rv:workRevision " + iri(CANDIDATE) + "; rv:controlRevision " + iri(CONTROL)
                    : iri(PROTECTION) + " a rv:ProtectionRevision; rv:component " + iri(WORK)
                    + "; rv:workRevision " + iri(HEAD) + "; rv:protectionAction rv:Confirm; rv:protectionMode rv:ReviewRequired; rv:protectionEpoch 1")
                + " } GRAPH " + iri(CommandPolicy.RECEIPTS) + " { " + iri(RECEIPT)
                + " rv:outcome rv:Succeeded; rv:work " + iri(WORK) + "; rv:expectedHead " + iri(HEAD)
                + "; rv:expectedProtection " + (review ? iri(PROTECTION) : "rv:Absent")
                + "; rv:expectedControl rv:Absent; rv:expectedControlEpoch 0; "
                + (review ? "rv:decision " + iri(decision) + "; rv:proposalRevision " + iri(PROPOSAL)
                    + "; rv:expectedDecision rv:Absent; rv:reviewOutcome rv:Accepted; "
                    : "rv:protectionRevision " + iri(PROTECTION) + "; ")
                + "rv:admissionId \"reviewer\"; rv:action " + literal(action)
                + "; rv:authorityEpoch \"1\"; rv:admittedScope " + literal(scope) + " } "
                + "GRAPH " + iri(CommandPolicy.OUTBOX) + " { <urn:rezics:event:protection-test> rv:receipt " + iri(RECEIPT) + " } } "
                + "WHERE { GRAPH " + iri(CommandPolicy.CURRENT) + " { " + iri(WORK) + " rdfs:label ?old } }";
            JsonArray claims = new JsonArray();
            for (String claim : new String[] { "rezics-work-protection-admission-v1", "reviewer", action, scope, "1",
                RECEIPT, "digest", sha(update), Instant.now().plusSeconds(60).toString(), review ? "proposer" : "" }) claims.add(claim);
            Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(KEY, "HmacSHA256"));
            JsonObject proof = new JsonObject(); proof.put("payload", claims.toString());
            proof.put("signature", HexFormat.of().formatHex(mac.doFinal(claims.toString().getBytes(StandardCharsets.UTF_8))));
            var snapshot = ProtectionPolicy.capture(data, CommandPolicy.parse(update, RECEIPT), RECEIPT,
                "digest", update, unsigned ? null : proof, KEY);
            if (snapshot.error() != null) return snapshot.error();
            UpdateAction.parseExecute(update, DatasetFactory.wrap(data));
            String error = ProtectionPolicy.check(data, RECEIPT, snapshot);
            if (error != null) return error;
            ProfileRegistry profiles = ProfileRegistry.load(Files.isDirectory(Path.of("profiles"))
                ? Path.of("profiles") : Path.of("../../../generated/model"));
            var canonical = CanonicalPolicy.validate(profiles, data, CONTROL, true);
            if (canonical != null) return String.valueOf(canonical.get("report"));
            org.junit.Assert.assertTrue(data.contains(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI(WORK),
                NodeFactory.createURI("http://www.w3.org/2000/01/rdf-schema#label"),
                NodeFactory.createLiteralLang(review ? "訂正した名前" : "元の名前", language)));
            data.commit(); committed = true;
            return null;
        } finally { if (!committed) data.abort(); data.end(); data.close(); }
    }

    @Test public void g512ProtectionConfirmCommitsTheNativeLanguage() throws Exception {
        for (String language : new String[] { "ja", "zh-Hant" }) {
            assertNull(protectedTransaction(false, language, language, false));
            assertEquals("protection revision basis or transition differs", protectedTransaction(false, language, "en", false));
        }
        assertEquals("trusted protection admission required", protectedTransaction(false, "ja", "ja", true));
    }

    @Test public void g512ApprovedCorrectionCommitsTheProposalLanguage() throws Exception {
        for (String language : new String[] { "ja", "zh-Hant" }) {
            assertNull(protectedTransaction(true, language, language, false));
            assertEquals("reviewed correction basis differs", protectedTransaction(true, language, "en", false));
        }
        assertEquals("trusted protection admission required", protectedTransaction(true, "ja", "ja", true));
    }

}
