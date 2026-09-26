import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import net.fabricmc.api.EnvType;
import net.fabricmc.loader.impl.metadata.DependencyOverrides;
import net.fabricmc.loader.impl.metadata.LoaderModMetadata;
import net.fabricmc.loader.impl.metadata.ModMetadataParser;
import net.fabricmc.loader.impl.metadata.VersionOverrides;
import net.fabricmc.loader.impl.discovery.ModCandidateImpl;
import net.fabricmc.loader.impl.discovery.ModResolver;
import net.fabricmc.loader.impl.discovery.ModResolutionException;

public class FabricOracle {
  public static void main(String[] args) throws Exception {
    var versions = new VersionOverrides();
    var dependencies = new DependencyOverrides(Path.of("."));
    var candidates = new ArrayList<ModCandidateImpl>();
    var nestedMode = args.length > 1 && args[1].equals("--nested");
    var nested = new ArrayList<ModCandidateImpl>();
    for (int i = nestedMode ? 2 : 1; i < args.length; i++) {
      var path = Path.of(args[i]);
      LoaderModMetadata metadata;
      try (InputStream stream = Files.newInputStream(path)) {
        metadata = ModMetadataParser.parseMetadata(stream, path.toString(), new ArrayList<>(),
            versions, dependencies, false);
      }
      var create = ModCandidateImpl.class.getDeclaredMethod("createPlain", List.class,
          LoaderModMetadata.class, boolean.class, java.util.Collection.class);
      create.setAccessible(true);
      if (metadata.loadsInEnvironment(EnvType.valueOf(args[0]))) {
        if (nestedMode && i == 3) {
          var createNested = ModCandidateImpl.class.getDeclaredMethod("createNested", String.class,
              long.class, LoaderModMetadata.class, boolean.class, java.util.Collection.class);
          createNested.setAccessible(true);
          nested.add((ModCandidateImpl) createNested.invoke(null,
              "META-INF/jars/child.jar", 0L, metadata, false, List.of()));
        } else {
          candidates.add((ModCandidateImpl) create.invoke(null, List.of(path), metadata, false, nested));
        }
      }
      System.out.println("PARSED " + metadata.getId() + " " + metadata.getEnvironment()
          + " nested=" + metadata.getJars().size());
    }
    if (nestedMode && !nested.isEmpty()) {
      var parent = candidates.get(0);
      var child = nested.get(0);
      var addParent = ModCandidateImpl.class.getDeclaredMethod("addParent", ModCandidateImpl.class);
      addParent.setAccessible(true);
      addParent.invoke(child, parent);
      candidates.add(child);
    }
    try {
      var selected = ModResolver.resolve(candidates, EnvType.valueOf(args[0]), new HashMap<>());
      System.out.println("SELECTED " + selected.stream().map(ModCandidateImpl::getId).sorted().toList());
    } catch (ModResolutionException error) {
      System.out.println("REJECTED " + error.getMessage());
    }
  }
}
