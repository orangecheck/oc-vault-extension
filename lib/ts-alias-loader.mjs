// node --test only: resolves the '@/' alias and extensionless imports between .ts files.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@/'))
        return next(new URL(`${specifier.slice(2)}.ts`, ROOT).href, context);
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
        const url = new URL(`${specifier}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
}
