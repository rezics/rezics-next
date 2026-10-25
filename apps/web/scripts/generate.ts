import { compile } from '@inlang/paraglide-js';
import options from '../project.inlang/paraglide.config';

await compile({ project: './project.inlang', ...options });
