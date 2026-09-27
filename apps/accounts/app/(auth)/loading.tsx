import { AuthFrame } from '../../features/shell/auth-frame.tsx';
import { AuthSkeleton } from '../../features/shell/skeletons.tsx';

export default function AuthLoading() {
  return <AuthFrame><AuthSkeleton /></AuthFrame>;
}
