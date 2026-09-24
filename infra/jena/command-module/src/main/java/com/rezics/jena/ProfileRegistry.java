package com.rezics.jena;

import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.atlas.json.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ModelFactory;
import org.apache.jena.riot.Lang;
import org.apache.jena.riot.RDFDataMgr;

final class ProfileRegistry {
    record Profile(String sha256, Model shapes) {}
    private final Map<String, Profile> profiles;

    private ProfileRegistry(Map<String, Profile> profiles) { this.profiles = Map.copyOf(profiles); }

    static ProfileRegistry load(Path directory) {
        try {
            Path base = directory.toRealPath();
            JsonValue entries = JSON.parse(Files.readString(base.resolve("manifest.json"))).get("profiles");
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
                if (loaded.putIfAbsent(id, new Profile(actual, model)) != null) throw new IllegalArgumentException("duplicate profile: " + id);
            }
            return new ProfileRegistry(loaded);
        } catch (IOException | NoSuchAlgorithmException ex) {
            throw new IllegalStateException("cannot load command profiles", ex);
        }
    }

    static String required(JsonObject object, String field) {
        JsonValue value = object.get(field);
        if (value == null || !value.isString() || value.getAsString().value().isBlank()) throw new IllegalArgumentException("missing " + field);
        return value.getAsString().value();
    }

    Profile get(String id) { return profiles.get(id); }
    Map<String, String> digests() {
        Map<String, String> result = new LinkedHashMap<>();
        profiles.forEach((id, profile) -> result.put(id, profile.sha256()));
        return result;
    }
}
