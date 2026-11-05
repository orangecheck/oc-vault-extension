/**
 * Light or dark, as the browser is. app-design's dark tokens apply under `.dark` on <html>.
 * There is no ThemeProvider: next-themes would add an inline script, and the extension
 * pages allow only their own bundled scripts (wxt.config.ts).
 */
export function followColorScheme(): void {
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', dark.matches);
    apply();
    dark.addEventListener('change', apply);
}
