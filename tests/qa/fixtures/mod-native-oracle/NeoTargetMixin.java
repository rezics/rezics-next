package oracle.mixin;
import oracle.NeoTarget;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Overwrite;
@Mixin(NeoTarget.class)
public class NeoTargetMixin {
  @Overwrite public String value() { return "mixed"; }
}
