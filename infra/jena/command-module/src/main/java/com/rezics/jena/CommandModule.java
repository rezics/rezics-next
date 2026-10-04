package com.rezics.jena;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.Properties;
import java.util.Set;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.main.sys.FusekiAutoModule;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.assembler.Assembler;
import org.apache.jena.rdf.model.Model;
import org.apache.jena.rdf.model.ResourceFactory;

public final class CommandModule implements FusekiAutoModule {
    /** The pom.xml project version, filtered into module.properties at build time. */
    static final String VERSION = version();
    private static final Operation COMMAND = Operation.alloc("https://rezics.com/fuseki/command", "command", "REZICS transactional command");
    private final ProfileRegistry profiles = profiles();

    private static String version() {
        try (InputStream in = CommandModule.class.getResourceAsStream("module.properties")) {
            if (in == null) throw new IllegalStateException("command module version resource missing");
            Properties properties = new Properties();
            properties.load(in);
            String version = properties.getProperty("version", "");
            if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+"))
                throw new IllegalStateException("invalid command module version: " + version);
            return version;
        } catch (IOException ex) {
            throw new IllegalStateException("cannot read command module version", ex);
        }
    }

    private static ProfileRegistry profiles() {
        ProfileRegistry registry = ProfileRegistry.load(Path.of(System.getProperty("rezics.profiles", "/fuseki/profiles")));
        if (!VERSION.equals(registry.commandModule()))
            throw new IllegalStateException("profile manifest targets command module " + registry.commandModule()
                + ", not " + VERSION);
        return registry;
    }

    @Override public String name() { return "rezics-command"; }

    @Override public void start() {
        registerTextAssembler();
    }

    static void registerTextAssembler() {
        org.apache.jena.query.text.TextQuery.init();
        Assembler.general().implementWith(
            ResourceFactory.createResource("https://rezics.com/fuseki/FilteredGraphTextIndex"),
            new FilteredGraphTextAssembler());
        org.apache.jena.sparql.function.FunctionRegistry.get().put(
            "https://rezics.com/vocab/publicTextInventory", FilteredGraphTextAssembler.InventoryFunction.class);
        org.apache.jena.sparql.function.FunctionRegistry.get().put(
            "https://rezics.com/vocab/rankedText", FilteredGraphTextIndex.RankedFunction.class);
        org.apache.jena.sparql.function.FunctionRegistry.get().put(
            "https://rezics.com/vocab/occurrenceSearch", OccurrenceLabelIndex.SearchFunction.class);
    }

    @Override public void prepare(FusekiServer.Builder builder, Set<String> datasetNames, Model configModel) {
        builder.registerOperation(COMMAND, new CommandService(profiles));
    }

    @Override public void configDataAccessPoint(org.apache.jena.fuseki.server.DataAccessPoint point, Model configModel) {
        OccurrenceTextSchema.rebuildIfIncompatible(point.getDataService().getDataset());
        // Qualification precedes HTTP traffic, including after an offline rebuild.
        // An empty/uninitialized dataset qualifies when bootstrap commits instead.
        if (CommandService.deltaExclusive(point.getDataService()))
            SearchDeltaJournal.qualifyAtStartup(point.getDataService().getDataset());
    }

    @Override public void serverStopped(FusekiServer server) {
        server.getDataAccessPointRegistry().accessPoints().forEach(point ->
            SearchDeltaJournal.stopRecovery(point.getDataService().getDataset()));
    }
}
