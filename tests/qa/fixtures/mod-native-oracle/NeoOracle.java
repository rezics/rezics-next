import java.nio.file.Path;
import net.neoforged.fml.jarcontents.JarContents;
import net.neoforged.fml.loading.moddiscovery.ModFile;
import net.neoforged.fml.loading.moddiscovery.ModFileParser;
import net.neoforged.neoforgespi.locating.IModFile;
import net.neoforged.neoforgespi.locating.ForgeFeature;
import net.neoforged.neoforgespi.language.IModInfo;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.loading.LoadingModList;
import net.neoforged.fml.loading.mixin.MixinFacade;
import java.util.List;
import java.util.Map;

public class NeoOracle {
  public static void main(String[] args) throws Exception {
    var file = (ModFile) IModFile.create(JarContents.ofPath(Path.of(args[0])),
        ModFileParser::modsTomlParser);
    for (var mod : file.getModInfos()) {
      System.out.println("MOD " + mod.getModId() + " " + mod.getVersion());
      for (var feature : mod.getForgeFeatures()) {
        System.out.println("FEATURE " + feature.featureName() + " " + feature.featureBound());
        ForgeFeature.registerFeature(feature.featureName(),
            ForgeFeature.VersionFeatureTest.forVersionString(IModInfo.DependencySide.CLIENT, "3.1"));
        System.out.println("FEATURE_CLIENT_3_1 " + ForgeFeature.testFeature(Dist.CLIENT, feature));
        System.out.println("FEATURE_SERVER_3_1 " + ForgeFeature.testFeature(Dist.DEDICATED_SERVER, feature));
      }
      for (var dependency : mod.getDependencies()) {
        System.out.println("DEPENDENCY " + dependency.getModId() + " "
            + dependency.getSide() + " " + dependency.getOrdering() + " "
            + dependency.getType() + " " + dependency.getVersionRange());
      }
    }
    for (var mixin : file.getMixinConfigs()) {
      System.out.println("MIXIN " + mixin.config() + " " + mixin.requiredMods());
      var presentFile = (ModFile) IModFile.create(JarContents.ofPath(Path.of(args[1])),
          ModFileParser::modsTomlParser);
      var conditional = MixinFacade.class.getDeclaredMethod("areRequiredModsPresent",
          ModFile.class, ModFileParser.MixinConfig.class, LoadingModList.class);
      conditional.setAccessible(true);
      var absent = LoadingModList.of(List.of(), List.of(), List.of(file),
          List.of((net.neoforged.fml.loading.moddiscovery.ModInfo) file.getModInfos().getFirst()),
          List.of(), Map.of());
      var present = LoadingModList.of(List.of(), List.of(), List.of(file, presentFile),
          List.of((net.neoforged.fml.loading.moddiscovery.ModInfo) file.getModInfos().getFirst(),
              (net.neoforged.fml.loading.moddiscovery.ModInfo) presentFile.getModInfos().getFirst()),
          List.of(), Map.of());
      System.out.println("MIXIN_WITHOUT_REQUIRED_MOD " + conditional.invoke(null, file, mixin, absent));
      System.out.println("MIXIN_WITH_REQUIRED_MOD " + conditional.invoke(null, file, mixin, present));
    }
  }
}
