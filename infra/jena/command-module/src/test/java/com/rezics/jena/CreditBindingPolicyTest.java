package com.rezics.jena;

import static org.junit.Assert.*;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Exercises the installed registry and production admission helpers, without a server. */
public class CreditBindingPolicyTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String SCHEMA = "https://schema.org/";
    private static final String CREDIT = id(2), REVISION = id(5), WORK = id(1), HEAD = id(3), ACTOR = id(4), AGENT = id(6);
    private static final String RECEIPT = "urn:rezics:receipt:work-edit:00000000-0000-4000-8000-000000000005";
    private static final List<String> GRAPHS = List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS,
        CommandPolicy.RECEIPTS, CommandPolicy.CONTROL);
    private static String id(int n) { return "https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012x", n); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node integer(int value) { return NodeFactory.createLiteralByValue(value,
        org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    private static ProfileRegistry registry() {
        return ProfileRegistry.load(Files.isDirectory(Path.of("profiles")) ? Path.of("profiles") : Path.of("../../../generated/model"));
    }

    private static final class Fixture implements AutoCloseable {
        final ProfileRegistry profiles = registry();
        final DatasetGraph data = DatasetFactory.createTxnMem().asDatasetGraph();
        final String profile, definition;
        final Map<String, String> binding = new LinkedHashMap<>();
        Fixture(boolean agent, boolean successor) {
            data.begin(ReadWrite.WRITE);
            profile = (agent ? "native-agent-credit" : "work-author-credit") + (successor ? "-v2" : "-v1");
            definition = "https://rezics.com/definition/" + profile;
            put(CommandPolicy.CURRENT, WORK, RDF.type.getURI(), uri(SCHEMA + "CreativeWork"));
            put(CommandPolicy.CURRENT, AGENT, RDF.type.getURI(), uri(RV + "Agent"));
            put(CommandPolicy.CURRENT, WORK, RV + "head", uri(HEAD));
            put(CommandPolicy.REVISIONS, HEAD, RDF.type.getURI(), uri(RV + "RevisionAnchor"));
            put(CommandPolicy.REVISIONS, HEAD, RV + "component", uri(WORK));
            for (String subject : List.of(CREDIT, REVISION)) {
                String graph = subject.equals(CREDIT) ? CommandPolicy.CURRENT : CommandPolicy.REVISIONS;
                put(graph, subject, RDF.type.getURI(), uri(RV + (agent ? "NativeAgentCredit" : "AuthorCredit")
                    + (subject.equals(REVISION) ? "Revision" : "")));
                put(graph, subject, RV + "work", uri(WORK));
                put(graph, subject, SCHEMA + "roleName", text(successor ? "performer" : "author"));
                if (agent) put(graph, subject, RV + "agent", uri(AGENT));
                else {
                    put(graph, subject, RV + "externalProvider", text("vndb"));
                    put(graph, subject, RV + "externalNamespace", text("staff"));
                    put(graph, subject, RV + "externalKey", text("s17"));
                    put(graph, subject, SCHEMA + "position", integer(2));
                    put(graph, subject, RV + "editControl", uri(RV + "HumanConfirmed"));
                    put(graph, subject, RV + "rightsStatus", uri(RV + "Undetermined"));
                }
            }
            data.add(uri(CommandPolicy.REVISIONS), uri(REVISION), RDF.type.asNode(), uri(RV + "RevisionAnchor"));
            put(CommandPolicy.CURRENT, CREDIT, RV + "creditRevision", uri(REVISION));
            if (successor) put(CommandPolicy.CURRENT, CREDIT, RV + "modelRevision", uri(definition));
            put(CommandPolicy.REVISIONS, REVISION, RV + "component", uri(CREDIT));
            put(CommandPolicy.REVISIONS, REVISION, RV + "workRevision", uri(HEAD));
            put(CommandPolicy.REVISIONS, REVISION, RV + "confirmedBy", uri(ACTOR));
            put(CommandPolicy.REVISIONS, REVISION, RV + "modelRevision", uri(definition));
            put(CommandPolicy.REVISIONS, REVISION, RV + "shapeRevision", uri(definition));
            put(CommandPolicy.REVISIONS, REVISION, RV + "dataEpoch", text("credit-epoch"));
            put(CommandPolicy.REVISIONS, REVISION, RV + "sequence", integer(12));
            for (String[] link : new String[][] { { "authorCredit", CREDIT }, { "creditRevision", REVISION },
                { "work", WORK }, { "workRevision", HEAD }, { "expectedHead", HEAD }, { "sourceIntent", CREDIT } })
                put(CommandPolicy.RECEIPTS, RECEIPT, RV + link[0], uri(link[1]));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "admittedScope", text("work:edit:" + WORK));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "authorityEpoch", text("7"));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "outcome", uri(RV + "Succeeded"));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "dataEpoch", text("credit-epoch"));
            put(CommandPolicy.RECEIPTS, RECEIPT, RV + "sequence", integer(12));
            binding.putAll(Map.of("credit", CREDIT, "revision", REVISION, "work", WORK, "work-head", HEAD,
                "key", "s17", "ordinal", "2", "actor", ACTOR, "receipt", RECEIPT, "scope", "work:edit:" + WORK));
            binding.putAll(Map.of("epoch", "7", "intent", CREDIT, "provider", "vndb", "namespace", "staff",
                "role", successor ? "performer" : "author"));
        }
        void put(String graph, String subject, String predicate, Node value) {
            data.deleteAny(uri(graph), uri(subject), uri(predicate), Node.ANY);
            data.add(uri(graph), uri(subject), uri(predicate), value);
        }
        List<CommandService.Validation> entries(Map<String, String> args, List<String> graphs) {
            return List.of(new CommandService.Validation(profile, profiles.get(profile), definition + "/credit-shape", List.of(CREDIT), graphs, args),
                new CommandService.Validation(profile, profiles.get(profile), definition + "/revision-shape", List.of(REVISION), graphs, args));
        }
        String check() { return BindingPolicy.check(data, profile, profiles.get(profile).binding(), entries(binding, GRAPHS)); }
        @Override public void close() { data.abort(); data.end(); data.close(); }
    }

    @Test public void explicitSuccessorKeepsTheExactOwnerBindingAndV1Default() {
        for (boolean successor : List.of(false, true)) try (var f = new Fixture(false, successor)) {
            assertNull(f.check());
            for (boolean revision : List.of(false, true)) {
                String subject = revision ? REVISION : CREDIT;
                var selected = CanonicalPolicy.select(f.profiles, f.data, subject, revision);
                assertEquals(f.profile, selected.route().profile());
                assertNull(CanonicalPolicy.validateSelected(f.profiles, f.data, subject, selected));
                assertEquals(f.profile, CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, subject, revision));
            }
        }
    }

    @Test public void bothParticipantFamiliesNeedExactSuccessorPinsAndExternalCreditsStillForbidAgents() {
        for (boolean agent : List.of(false, true)) try (var f = new Fixture(agent, true)) {
            assertNull(CanonicalPolicy.validate(f.profiles, f.data, CREDIT, false));
            assertNull(CanonicalPolicy.validate(f.profiles, f.data, REVISION, true));
            f.put(CommandPolicy.REVISIONS, REVISION, RV + "shapeRevision", uri(f.definition.replace("-v2", "-v1")));
            assertNotNull(CanonicalPolicy.validate(f.profiles, f.data, REVISION, true));
            f.put(CommandPolicy.REVISIONS, REVISION, RV + "shapeRevision", uri(f.definition));
            f.data.deleteAny(uri(CommandPolicy.CURRENT), uri(CREDIT), uri(RV + "modelRevision"), Node.ANY);
            assertNotNull(CanonicalPolicy.validate(f.profiles, f.data, CREDIT, false));
            f.put(CommandPolicy.CURRENT, CREDIT, RV + "modelRevision", uri(f.definition));
            if (!agent) {
                f.put(CommandPolicy.CURRENT, CREDIT, RV + "agent", uri(AGENT));
                assertNotNull(CanonicalPolicy.validate(f.profiles, f.data, CREDIT, false));
            } else assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, CREDIT, false));
        }
    }

    @Test public void successorBindingRefusesOtherReceiptsWorkHeadsAndParticipants() {
        for (String field : List.of("receipt", "work", "work-head", "key", "provider", "namespace", "ordinal", "actor", "intent"))
            try (var f = new Fixture(false, true)) {
                f.binding.put(field, switch (field) {
                    case "key", "provider", "namespace" -> "other";
                    case "ordinal" -> "3";
                    default -> id(99);
                });
                if (field.equals("work")) f.binding.put("scope", "work:edit:" + id(99));
                assertNotNull(field, f.check());
            }
        for (String field : List.of("authorCredit", "creditRevision", "work", "workRevision", "expectedHead", "sourceIntent"))
            try (var f = new Fixture(false, true)) {
                f.put(CommandPolicy.RECEIPTS, RECEIPT, RV + field, uri(id(99)));
                assertNotNull(field, f.check());
            }
    }

    @Test public void selectedSuccessorCannotUseOmittedHistoricalOrMixedBindings() throws Exception {
        try (var f = new Fixture(false, true)) {
            var entries = f.entries(f.binding, GRAPHS);
            Method focus = CommandService.class.getDeclaredMethod("boundFocus", List.class, String.class, String.class);
            focus.setAccessible(true);
            String demand = CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, CREDIT, false);
            assertEquals("work-author-credit-v2", demand);
            assertEquals(true, focus.invoke(null, entries, demand, CREDIT));
            assertEquals(false, focus.invoke(null, List.of(), demand, CREDIT));
            var historical = new CommandService.Validation("work-author-credit-v1", f.profiles.get("work-author-credit-v1"),
                "https://rezics.com/definition/work-author-credit-v1/credit-shape", List.of(CREDIT), GRAPHS, f.binding);
            assertEquals(false, focus.invoke(null, List.of(historical), demand, CREDIT));
            assertThrows(IllegalArgumentException.class, () -> BindingPolicy.check(f.data, f.profile,
                f.profiles.get(f.profile).binding(), f.entries(Map.of(), GRAPHS)));
            var mixed = new ArrayList<>(entries);
            var changed = new LinkedHashMap<>(f.binding); changed.put("key", "other");
            mixed.set(1, f.entries(changed, GRAPHS).get(1));
            assertThrows(IllegalArgumentException.class, () -> BindingPolicy.check(f.data, f.profile,
                f.profiles.get(f.profile).binding(), mixed));
        }
    }

    @SuppressWarnings("unchecked")
    private static List<CommandService.Validation> parse(Fixture f, List<String> graphs) throws Exception {
        var rows = new JsonArray();
        for (var validation : f.entries(f.binding, graphs)) {
            var entry = new JsonObject();
            entry.put("profile", validation.profileId()); entry.put("sha256", validation.profile().sha256());
            entry.put("shape", validation.shape());
            var focus = new JsonArray(); validation.focus().forEach(focus::add); entry.put("focus", focus);
            var selected = new JsonArray(); validation.graphs().forEach(selected::add); entry.put("graphs", selected);
            var args = new JsonObject(); validation.binding().forEach(args::put); entry.put("binding", args);
            rows.add(entry);
        }
        Method parse = CommandService.class.getDeclaredMethod("parseValidations", JsonValue.class);
        parse.setAccessible(true);
        try {
            return (List<CommandService.Validation>) parse.invoke(new CommandService(f.profiles,
                "1".repeat(64).getBytes(), "2".repeat(64).getBytes(), "3".repeat(64).getBytes()), rows);
        } catch (InvocationTargetException e) {
            if (e.getCause() instanceof IllegalArgumentException invalid) throw invalid;
            throw e;
        }
    }

    @Test public void successorValidationAdmitsOnlyTheCompleteReceiptGraphSet() throws Exception {
        try (var f = new Fixture(false, true)) {
            assertEquals(2, parse(f, GRAPHS).size());
            for (String omitted : GRAPHS) assertThrows(IllegalArgumentException.class,
                () -> parse(f, GRAPHS.stream().filter(graph -> !graph.equals(omitted)).toList()));
            var extra = new ArrayList<>(GRAPHS); extra.add("urn:rezics:graph:source");
            assertThrows(IllegalArgumentException.class, () -> parse(f, extra));
        }
    }

    @Test public void fixedGlobalAndUndemandedAgentKeepTheirExistingExceptions() {
        try (var f = new Fixture(true, true)) {
            assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, CREDIT, false));
            assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, REVISION, true));
            String global = "urn:rezics:classification-context:global";
            f.put(CommandPolicy.CURRENT, global, RDF.type.getURI(), uri(RV + "ClassificationContext"));
            f.put(CommandPolicy.CURRENT, global, RV + "contextRole", uri(RV + "GlobalClassification"));
            assertNull(CanonicalPolicy.requiredBindingProfile(f.profiles, f.data, global, false));
        }
    }
}
