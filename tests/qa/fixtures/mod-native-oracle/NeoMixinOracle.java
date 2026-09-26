import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.loading.FMLLoader;
import net.neoforged.fml.loading.LoadingModList;
import net.neoforged.fml.loading.mixin.MixinFacade;
import net.neoforged.fml.loading.moddiscovery.ModFile;
import net.neoforged.fml.loading.moddiscovery.ModFileParser;
import net.neoforged.neoforgespi.locating.IModFile;
import net.neoforged.fml.jarcontents.JarContents;
import net.neoforged.neoforgespi.transformation.BytecodeProvider;
import net.neoforged.neoforgespi.transformation.ClassProcessor;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.Type;
import org.objectweb.asm.tree.ClassNode;
import org.objectweb.asm.tree.LdcInsnNode;
import org.spongepowered.asm.mixin.Mixins;
import org.spongepowered.asm.mixin.MixinEnvironment;
import org.spongepowered.asm.launch.MixinBootstrap;

public class NeoMixinOracle {
  public static void main(String[] args) throws Exception {
    var unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
    unsafeField.setAccessible(true);
    var unsafe = (sun.misc.Unsafe) unsafeField.get(null);
    var loader = (FMLLoader) unsafe.allocateInstance(FMLLoader.class);
    var dist = FMLLoader.class.getDeclaredField("dist");
    dist.setAccessible(true);
    dist.set(loader, Dist.CLIENT);
    var current = FMLLoader.class.getDeclaredField("current");
    current.setAccessible(true);
    ((AtomicReference<FMLLoader>) current.get(null)).set(loader);
    var file = (ModFile) IModFile.create(JarContents.ofPath(Path.of("root")),
        ModFileParser::modsTomlParser);
    var other = (ModFile) IModFile.create(JarContents.ofPath(Path.of("other")),
        ModFileParser::modsTomlParser);
    var present = args[0].equals("present");
    var files = present ? List.of(file, other) : List.of(file);
    var infos = files.stream().map(mod -> (net.neoforged.fml.loading.moddiscovery.ModInfo)
        mod.getModInfos().getFirst()).toList();
    var list = LoadingModList.of(List.of(), List.of(), files, infos, List.of(), Map.of());
    try (var facade = new MixinFacade()) {
      var source = (BytecodeProvider) name -> {
        try { return Files.readAllBytes(Path.of(name.replace('.', '/') + ".class")); }
        catch (java.io.IOException error) { throw new ClassNotFoundException(name, error); }
      };
      facade.getClassProcessor().link(new ClassProcessor.LinkContext(new java.util.LinkedHashMap<>(), source));
      var add = MixinFacade.class.getDeclaredMethod("addMixins", LoadingModList.class);
      add.setAccessible(true);
      add.invoke(facade, list);
      var phase = MixinEnvironment.class.getDeclaredMethod("gotoPhase", MixinEnvironment.Phase.class);
      phase.setAccessible(true);
      phase.invoke(null, MixinEnvironment.Phase.INIT);
      phase.invoke(null, MixinEnvironment.Phase.DEFAULT);
      MixinBootstrap.init();
      MixinBootstrap.getPlatform().inject();
      System.out.println("REGISTERED " + Mixins.getConfigs().stream().map(config -> config.getName()).toList());
      var target = Files.readAllBytes(Path.of("oracle/NeoTarget.class"));
      var node = new ClassNode();
      new ClassReader(target).accept(node, 0);
      var context = new ClassProcessor.TransformationContext(Type.getObjectType("oracle/NeoTarget"),
          node, false, (activity, details) -> {}, () -> new byte[32]);
      var result = facade.getClassProcessor().processClass(context);
      System.out.println("TRANSFORMED " + result);
      var method = node.methods.stream().filter(candidate -> candidate.name.equals("value"))
          .findFirst().orElseThrow();
      String value = null;
      for (var instruction : method.instructions) {
        if (instruction instanceof LdcInsnNode literal && literal.cst instanceof String string) {
          value = string;
        }
      }
      System.out.println("MIXIN_RESULT " + value);
    }
  }
}
