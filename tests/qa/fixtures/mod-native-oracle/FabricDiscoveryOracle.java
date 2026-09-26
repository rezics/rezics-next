import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import net.fabricmc.api.EnvType;
import net.fabricmc.loader.impl.FabricLoaderImpl;
import net.fabricmc.loader.impl.game.GameProvider;
import net.fabricmc.loader.impl.metadata.DependencyOverrides;
import net.fabricmc.loader.impl.metadata.VersionOverrides;
import net.fabricmc.loader.impl.launch.FabricLauncher;
import net.fabricmc.loader.impl.launch.FabricLauncherBase;
import net.fabricmc.loader.impl.discovery.ModDiscoverer;
import net.fabricmc.loader.impl.discovery.ModCandidateImpl;

/** Exercises actual Fabric archive scanning and nested candidate extraction. */
public class FabricDiscoveryOracle {
  private static byte[] jar(String manifest, String childPath, byte[] child) throws Exception {
    var bytes = new ByteArrayOutputStream();
    try (var zip = new ZipOutputStream(bytes)) {
      zip.putNextEntry(new ZipEntry("fabric.mod.json"));
      zip.write(manifest.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      zip.closeEntry();
      if (childPath != null) {
        zip.putNextEntry(new ZipEntry(childPath));
        zip.write(child);
        zip.closeEntry();
      }
    }
    return bytes.toByteArray();
  }

  public static void main(String[] args) throws Exception {
    var parentManifest = Files.readString(Path.of(args[1]));
    var childManifest = Files.readString(Path.of(args[2]));
    var child = jar(childManifest, null, null);
    var parent = Path.of("physical-parent.jar");
    Files.write(parent, jar(parentManifest, args.length > 3 ? args[3] : "META-INF/jars/child.jar", child));
    var loader = FabricLoaderImpl.INSTANCE;
    loader.setGameProvider((GameProvider) Proxy.newProxyInstance(GameProvider.class.getClassLoader(),
        new Class<?>[] { GameProvider.class }, (proxy, method, arguments) -> {
          if (method.getName().equals("getBuiltinMods")) return List.of();
          if (method.getName().equals("getLaunchDirectory")) return Path.of(".");
          if (method.getName().equals("isEnabled")) return true;
          return null;
        }));
    FabricLauncherBase.setLauncher((FabricLauncher) Proxy.newProxyInstance(
        FabricLauncher.class.getClassLoader(), new Class<?>[] { FabricLauncher.class },
        (proxy, method, arguments) -> {
          if (method.getName().equals("getEnvironmentType")) return EnvType.valueOf(args[0]);
          if (method.getName().equals("isDevelopment")) return false;
          return null;
        }));
    var discoverer = new ModDiscoverer(new VersionOverrides(), new DependencyOverrides(Path.of(".")));
    var finderType = Class.forName("net.fabricmc.loader.impl.discovery.ModCandidateFinder");
    var finder = Proxy.newProxyInstance(
        finderType.getClassLoader(), new Class<?>[] { finderType },
        (proxy, method, arguments) -> {
          var consumer = arguments[0];
          var accept = Class.forName("net.fabricmc.loader.impl.discovery.ModCandidateFinder$ModCandidateConsumer")
              .getMethod("accept", List.class, boolean.class);
          accept.invoke(consumer, List.of(parent.toAbsolutePath()), false);
          return null;
        });
    var addFinder = ModDiscoverer.class.getMethod("addCandidateFinder", finderType);
    addFinder.invoke(discoverer, finder);
    var discovered = discoverer.discoverMods(loader, new HashMap<>());
    System.out.println("DISCOVERED " + discovered.stream().map(ModCandidateImpl::getId).sorted().toList());
    for (var candidate : discovered) {
      System.out.println("ARCHIVE " + candidate.getId() + " parent="
          + candidate.getParentMods().stream().map(ModCandidateImpl::getId).sorted().toList());
    }
  }
}
