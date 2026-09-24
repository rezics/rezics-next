package com.rezics.jena;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;

/** Fixed, node-local poststate bindings for the five profiles whose historical
 * candidate validators supplied request-specific hasValue constraints. No path,
 * shape, graph or query text comes from the request. */
final class BindingPolicy {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String SKOS = "http://www.w3.org/2004/02/skos/core#";
    private static final String GLOBAL = "urn:rezics:classification-context:global";
    private static final String ISOLATE = "https://rezics.com/definition/classification-isolate-v1";
    private static final String INHERIT = "https://rezics.com/definition/classification-inherit-global-v1";
    private static final Set<String> BOUND = Set.of(
        "classification-context-v1", "classification-direct-decision-v1",
        "classification-proposition-v1", "realm-standing-rating-context-v1",
        "realm-standing-rating-observation-v1");

    static boolean applies(String profile) { return BOUND.contains(profile); }

    private final Graph data;
    private final Map<String, String> focus;
    private final Map<String, String> args;
    private final List<String> violations = new ArrayList<>();

    private BindingPolicy(Graph data, Map<String, String> focus, Map<String, String> args) {
        this.data = data; this.focus = focus; this.args = args;
    }

    static String check(DatasetGraph dataset, String profile, List<CommandService.Validation> entries) {
        if (!applies(profile)) {
            if (entries.stream().anyMatch(entry -> !entry.binding().isEmpty()))
                throw new IllegalArgumentException("bindings are not admitted for this profile");
            return null;
        }
        Map<String, String> focus = new HashMap<>();
        Map<String, String> args = entries.get(0).binding();
        if (args.isEmpty()) throw new IllegalArgumentException("profile binding required: " + profile);
        Set<String> graphs = new HashSet<>();
        String prefix = "https://rezics.com/definition/" + profile + "/";
        for (CommandService.Validation entry : entries) {
            if (!entry.binding().equals(args)) throw new IllegalArgumentException("inconsistent profile bindings");
            if (!entry.shape().startsWith(prefix) || !entry.shape().endsWith("-shape")
                || entry.focus().size() != 1) throw new IllegalArgumentException("binding requires one named focus per role");
            String role = entry.shape().substring(prefix.length(), entry.shape().length() - "-shape".length());
            if (focus.putIfAbsent(role, entry.focus().get(0)) != null)
                throw new IllegalArgumentException("duplicate binding focus role");
            graphs.addAll(entry.graphs());
        }
        Graph data = SelectedGraphUnion.readOnly(dataset, graphs);
        BindingPolicy policy = new BindingPolicy(data, focus, args);
        policy.validate(profile);
        if (policy.violations.isEmpty()) return null;
        String report = String.join("\n", policy.violations);
        return report.substring(0, Math.min(4096, report.length()));
    }

    private void validate(String profile) {
        switch (profile) {
            case "classification-context-v1" -> classificationContext();
            case "classification-proposition-v1" -> classificationProposition();
            case "classification-direct-decision-v1" -> classificationDecision();
            case "realm-standing-rating-context-v1" -> ratingContext();
            case "realm-standing-rating-observation-v1" -> ratingObservation();
            default -> throw new IllegalArgumentException("unknown binding profile");
        }
    }

    private void keys(String required, String optional) {
        Set<String> allowed = new HashSet<>();
        for (String key : (required + " " + optional).trim().split(" +")) if (!key.isEmpty()) allowed.add(key);
        if (!allowed.containsAll(args.keySet())) throw new IllegalArgumentException("unknown binding key");
        for (String key : required.split(" +")) if (!args.containsKey(key) || args.get(key).isEmpty())
            throw new IllegalArgumentException("missing binding key: " + key);
        for (String value : args.values()) if (value.length() > 4096)
            throw new IllegalArgumentException("binding value too large");
    }

    private String arg(String key) { return args.get(key); }
    private String role(String key) {
        String value = focus.get(key);
        if (value == null || !value.equals(arg(key))) throw new IllegalArgumentException("binding focus differs: " + key);
        return value;
    }
    private void roles(String names) {
        Set<String> required = Set.of(names.split(" +"));
        if (!focus.keySet().equals(required)) throw new IllegalArgumentException("binding focus roles differ");
        for (String name : required) if (args.containsKey(name)) role(name);
    }
    private static Node iri(String value) {
        if (value == null || !(value.startsWith("https://") || value.startsWith("http://") || value.startsWith("urn:"))
            || value.indexOf(' ') >= 0 || value.indexOf('>') >= 0)
            throw new IllegalArgumentException("invalid binding IRI");
        return NodeFactory.createURI(value);
    }
    private void exact(String role, String predicate, Node expected) {
        check(focus.get(role), predicate, expected, true);
    }
    private void has(String role, String predicate, Node expected) {
        check(focus.get(role), predicate, expected, false);
    }
    private void at(String subject, String predicate, Node expected) {
        check(subject, predicate, expected, true);
    }
    private void absent(String role, String predicate) { check(focus.get(role), predicate, null, true); }
    private void check(String subject, String predicate, Node expected, boolean one) {
        if (subject == null) throw new IllegalArgumentException("missing binding role");
        var objects = data.find(iri(subject), iri(predicate), Node.ANY);
        int count = 0; boolean matched = false;
        while (objects.hasNext()) {
            Node object = objects.next().getObject(); count++;
            if (expected != null && object.sameValueAs(expected)) matched = true;
        }
        if (expected == null ? count != 0 : !matched || one && count != 1)
            violations.add("sh:focusNode <" + subject + "> ; sh:resultPath <" + predicate + "> ; sh:message \"binding differs\"");
    }

    private void classificationContext() {
        keys("realm context", ""); roles("global realm context");
        if (!GLOBAL.equals(focus.get("global"))) throw new IllegalArgumentException("global focus differs");
        has("realm", RV + "classificationContext", iri(role("context")));
        has("context", RV + "realm", iri(role("realm")));
    }
    private void classificationProposition() {
        keys("scheme concept path expression sense", ""); roles("scheme concept path expression sense");
        has("concept", SKOS + "inScheme", iri(role("scheme")));
        has("path", RV + "terminalConcept", iri(role("concept")));
        has("expression", RV + "path", iri(role("path")));
        has("expression", RV + "assertedConcept", iri(role("concept")));
        has("sense", RV + "path", iri(role("path")));
        has("sense", RV + "expression", iri(role("expression")));
    }
    private void ratingContext() {
        keys("realm context question", ""); roles("realm context");
        has("realm", RV + "ratingContext", iri(role("context")));
        has("context", RV + "realm", iri(role("realm")));
        has("context", RV + "question", NodeFactory.createLiteralLang(arg("question"), "en"));
    }
    private void ratingObservation() {
        keys("realm context work main slot observation revision availability", "value predecessor");
        roles("realm context work main observation revision");
        if (!Set.of("available", "withdrawn").contains(arg("availability")))
            throw new IllegalArgumentException("invalid rating availability binding");
        if (arg("availability").equals("available") != (arg("value") != null))
            throw new IllegalArgumentException("rating value binding differs from availability");
        has("realm", RV + "ratingContext", iri(role("context")));
        has("context", RV + "realm", iri(role("realm")));
        has("work", RV + "mainVersion", iri(role("main")));
        has("main", RV + "work", iri(role("work")));
        has("observation", RV + "ratingContext", iri(role("context")));
        has("observation", RV + "targetMainVersion", iri(role("main")));
        has("observation", RV + "ratingSlot", iri(arg("slot")));
        has("observation", RV + "observationHead", iri(role("revision")));
        has("revision", RV + "observation", iri(role("observation")));
        has("revision", RV + "ratingAvailability", iri(RV + (arg("availability").equals("available") ? "Available" : "Withdrawn")));
        if (arg("predecessor") == null) absent("revision", RV + "predecessor");
        else has("revision", RV + "predecessor", iri(arg("predecessor")));
        if (arg("value") == null) absent("revision", RV + "ratingValue");
        else {
            int value;
            try { value = Integer.parseInt(arg("value")); }
            catch (NumberFormatException ex) { throw new IllegalArgumentException("invalid rating value binding"); }
            if (value < 1 || value > 10) throw new IllegalArgumentException("invalid rating value binding");
            has("revision", RV + "ratingValue", NodeFactory.createLiteralByValue(value, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        }
    }
    private void classificationDecision() {
        keys("work main sense sense-revision context context-kind application decision slot proposer decider outcome",
            "realm context-revision predecessor");
        roles("work main sense context application decision");
        String kind = arg("context-kind");
        if (!Set.of("global", "realm").contains(kind) || !Set.of("accepted", "rejected").contains(arg("outcome")))
            throw new IllegalArgumentException("invalid classification decision binding");
        if (kind.equals("global") && (!GLOBAL.equals(role("context")) || arg("realm") != null || arg("context-revision") != null)
            || kind.equals("realm") && (GLOBAL.equals(role("context")) || arg("realm") == null || arg("context-revision") == null))
            throw new IllegalArgumentException("classification context binding differs");
        at(GLOBAL, "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", iri(RV + "ClassificationContext"));
        at(GLOBAL, RV + "contextRole", iri(RV + "GlobalClassification"));
        at(GLOBAL, RV + "contextState", iri(RV + "Active"));
        at(GLOBAL, RV + "inheritancePolicy", iri(ISOLATE));
        check(GLOBAL, RV + "realm", null, true);
        check(GLOBAL, RV + "fallbackContext", null, true);
        exact("work", RV + "mainVersion", iri(role("main")));
        exact("main", RV + "work", iri(role("work")));
        exact("sense", RV + "head", iri(arg("sense-revision")));
        exact("application", RV + "targetMainVersion", iri(role("main")));
        exact("application", RV + "sense", iri(role("sense")));
        exact("application", RV + "classificationContext", iri(role("context")));
        exact("application", RV + "applicationKey", iri(arg("slot")));
        exact("application", RV + "proposer", iri(arg("proposer")));
        exact("application", RV + "decisionHead", iri(role("decision")));
        exact("decision", RV + "application", iri(role("application")));
        exact("decision", RV + "outcome", iri(RV + (arg("outcome").equals("accepted") ? "Accepted" : "Rejected")));
        exact("decision", RV + "decisionBasis", iri(RV + (kind.equals("global") ? "GlobalCuratorReview" : "RealmManagerReview")));
        exact("decision", RV + "decidedBy", iri(arg("decider")));
        exact("context", RV + "contextRole", iri(RV + (kind.equals("global") ? "GlobalClassification" : "RealmClassification")));
        exact("context", RV + "inheritancePolicy", iri(kind.equals("global") ? ISOLATE : INHERIT));
        if (kind.equals("realm")) {
            exact("context", RV + "realm", iri(arg("realm")));
            exact("context", RV + "fallbackContext", iri(GLOBAL));
            exact("context", RV + "head", iri(arg("context-revision")));
            at(arg("realm"), "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", iri(RV + "Realm"));
            at(arg("realm"), RV + "realmState", iri(RV + "Active"));
            at(arg("realm"), RV + "classificationContext", iri(role("context")));
            exact("decision", RV + "contextRevision", iri(arg("context-revision")));
        } else {
            absent("context", RV + "realm"); absent("context", RV + "fallbackContext");
            absent("context", RV + "head"); absent("decision", RV + "contextRevision");
        }
        if (arg("predecessor") == null) absent("decision", RV + "predecessor");
        else exact("decision", RV + "predecessor", iri(arg("predecessor")));
    }
}
