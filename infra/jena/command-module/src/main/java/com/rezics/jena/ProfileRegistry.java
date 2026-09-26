package com.rezics.jena;

import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.atlas.json.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;
import org.apache.jena.vocabulary.RDF;

/** Generated profiles and the command registry from their manifest. The manifest
 * orders canonical types and binding demands; the first listed type a subject
 * carries decides, so no profile-specific chain lives in module code. */
final class ProfileRegistry {
    /** Generic binding rules; BindingPolicy keeps the profile-specific value checks. */
    record Binding(List<String> required, List<String> optional, List<String> roles) {}
    record Profile(String sha256, Model shapes, Binding binding) {}
    /** Holds when the subject has exactly one {@code path} value whose IRI or lexical form is {@code value}. */
    record Condition(String path, String value) {}
    record Route(String profile, String shape, List<Condition> when) {}
    /** Routes are most specific first; the compiler guarantees the first holding one is unique. */
    record Canonical(String type, List<Route> routes) {}

    private static final String SH = "http://www.w3.org/ns/shacl#";
    private final String commandModule;
    private final Map<String, Profile> profiles;
    private final List<Canonical> canonical;
    private final Map<String, String> bindingDemands;

    private ProfileRegistry(String commandModule, Map<String, Profile> profiles, List<Canonical> canonical,
                            Map<String, String> bindingDemands) {
        this.commandModule = commandModule;
        this.profiles = Map.copyOf(profiles);
        this.canonical = List.copyOf(canonical);
        this.bindingDemands = bindingDemands;
    }

    static ProfileRegistry load(Path directory) {
        try {
            Path base = directory.toRealPath();
            JsonObject manifest = JSON.parse(Files.readString(base.resolve("manifest.json")));
            JsonValue entries = manifest.get("profiles");
            if (entries == null || !entries.isArray() || entries.getAsArray().isEmpty()) throw new IllegalArgumentException("empty profile manifest");
            Map<String, Profile> loaded = new LinkedHashMap<>();
            for (JsonValue item : entries.getAsArray()) {
                JsonObject entry = item.getAsObject();
                String id = required(entry, "id");
                String expected = required(entry, "sha256");
                Path file = base.resolve(required(entry, "file")).normalize();
                if (!file.startsWith(base) || !Files.isRegularFile(file)) throw new IllegalArgumentException("invalid profile path: " + id);
                byte[] bytes = Files.readAllBytes(file);
                String actual = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
                if (!actual.equalsIgnoreCase(expected)) throw new IllegalArgumentException("profile digest mismatch: " + id);
                Model model = ModelFactory.createDefaultModel();
                RDFDataMgr.read(model, file.toUri().toString(), Lang.TTL);
                Binding binding = entry.get("binding") == null ? null : binding(entry.get("binding"), id);
                if (loaded.putIfAbsent(id, new Profile(actual, model, binding)) != null) throw new IllegalArgumentException("duplicate profile: " + id);
            }
            String commandModule = manifest.get("commandModule") == null ? null : required(manifest, "commandModule");
            return new ProfileRegistry(commandModule, loaded, canonical(manifest.get("canonical"), loaded),
                bindingDemands(manifest.get("bindingDemands"), loaded));
        } catch (IOException | NoSuchAlgorithmException ex) {
            throw new IllegalStateException("cannot load command profiles", ex);
        }
    }

    private static Binding binding(JsonValue value, String id) {
        if (!value.isObject()) throw new IllegalArgumentException("invalid binding: " + id);
        JsonObject object = value.getAsObject();
        List<String> required = strings(object.get("required"), true);
        List<String> optional = strings(object.get("optional"), false);
        List<String> roles = strings(object.get("roles"), true);
        Set<String> keys = new HashSet<>(required);
        keys.addAll(optional);
        if (keys.size() != required.size() + optional.size() || new HashSet<>(roles).size() != roles.size())
            throw new IllegalArgumentException("duplicate binding key or role: " + id);
        return new Binding(required, optional, roles);
    }

    private static List<Canonical> canonical(JsonValue value, Map<String, Profile> loaded) {
        if (value == null || !value.isArray()) throw new IllegalArgumentException("manifest lacks the canonical registry");
        List<Canonical> result = new ArrayList<>();
        Set<String> types = new HashSet<>();
        for (JsonValue item : value.getAsArray()) {
            JsonObject entry = item.getAsObject();
            String type = iri(required(entry, "type"));
            JsonValue routes = entry.get("routes");
            if (!types.add(type) || routes == null || !routes.isArray() || routes.getAsArray().isEmpty())
                throw new IllegalArgumentException("invalid canonical type: " + type);
            List<Route> parsed = new ArrayList<>();
            for (JsonValue routeValue : routes.getAsArray()) {
                JsonObject route = routeValue.getAsObject();
                String profile = required(route, "profile");
                String shape = iri(required(route, "shape"));
                Profile owner = loaded.get(profile);
                if (owner == null || !owner.shapes().contains(ResourceFactory.createResource(shape), RDF.type,
                    ResourceFactory.createResource(SH + "NodeShape")))
                    throw new IllegalArgumentException("canonical route names an unknown shape: " + shape);
                JsonValue when = route.get("when");
                if (when == null || !when.isArray()) throw new IllegalArgumentException("invalid canonical route: " + shape);
                List<Condition> conditions = new ArrayList<>();
                for (JsonValue condition : when.getAsArray())
                    conditions.add(new Condition(iri(required(condition.getAsObject(), "path")),
                        required(condition.getAsObject(), "value")));
                parsed.add(new Route(profile, shape, List.copyOf(conditions)));
            }
            result.add(new Canonical(type, List.copyOf(parsed)));
        }
        return result;
    }

    private static Map<String, String> bindingDemands(JsonValue value, Map<String, Profile> loaded) {
        if (value == null || !value.isArray()) throw new IllegalArgumentException("manifest lacks binding demands");
        Map<String, String> result = new LinkedHashMap<>();
        for (JsonValue item : value.getAsArray()) {
            JsonObject entry = item.getAsObject();
            String type = iri(required(entry, "type"));
            String profile = required(entry, "profile");
            Profile owner = loaded.get(profile);
            if (owner == null || owner.binding() == null || result.putIfAbsent(type, profile) != null)
                throw new IllegalArgumentException("invalid binding demand: " + type);
        }
        return java.util.Collections.unmodifiableMap(result);
    }

    private static List<String> strings(JsonValue value, boolean nonempty) {
        if (value == null && !nonempty) return List.of();
        if (value == null || !value.isArray() || nonempty && value.getAsArray().isEmpty())
            throw new IllegalArgumentException("invalid string list");
        List<String> result = new ArrayList<>();
        for (JsonValue item : value.getAsArray()) {
            if (!item.isString() || item.getAsString().value().isBlank()) throw new IllegalArgumentException("invalid string list");
            result.add(item.getAsString().value());
        }
        return List.copyOf(result);
    }

    private static String iri(String value) {
        if (!(value.startsWith("https://") || value.startsWith("http://") || value.startsWith("urn:")) || value.contains(" "))
            throw new IllegalArgumentException("invalid registry IRI: " + value);
        return value;
    }

    static String required(JsonObject object, String field) {
        JsonValue value = object.get(field);
        if (value == null || !value.isString() || value.getAsString().value().isBlank()) throw new IllegalArgumentException("missing " + field);
        return value.getAsString().value();
    }

    /** The module version the manifest was generated for, or null in a test fixture. */
    String commandModule() { return commandModule; }

    Profile get(String id) { return profiles.get(id); }

    /** The first registry type the subject carries, or null when it has none. */
    Canonical canonical(Set<String> types) {
        for (Canonical entry : canonical) if (types.contains(entry.type())) return entry;
        return null;
    }

    /** The profile whose bound validation must cover a subject with these types, or null. */
    String bindingDemand(Set<String> types) {
        for (var entry : bindingDemands.entrySet()) if (types.contains(entry.getKey())) return entry.getValue();
        return null;
    }

    Map<String, String> digests() {
        Map<String, String> result = new LinkedHashMap<>();
        profiles.forEach((id, profile) -> result.put(id, profile.sha256()));
        return result;
    }
}
