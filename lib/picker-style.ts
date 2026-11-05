/**
 * The in-page picker's look: app-design 2.x's tokens, by value.
 *
 * The picker, the save prompt and the field mark draw in shadow roots on other
 * sites' pages. The package's CSS is scoped to `<html data-oc-app>`, which is the
 * host page's element, so it cannot reach them: they carry the values themselves.
 * Each key is the package's own token name, and picker-style.test.mjs holds every
 * value to the package's tokens.css, light and dark.
 *
 * The mode follows the browser, as the popup does. The faces are the system's: a
 * host page loads no extension font.
 */

export const PICKER_TOKENS = {
    light: {
        '--popover': '#ffffff',
        '--popover-foreground': '#161412',
        '--muted-foreground': '#5e5852',
        '--accent': '#e4e0dc',
        '--oca-hairline-strong': '#c3bfbc',
        '--input': '#8a837d',
        '--primary': '#c2410c',
        '--primary-foreground': '#ffffff',
        '--oca-cta-hover': '#9a3412',
        '--ring': '#c2410c',
        '--oca-accent-ink': '#9a3412',
    },
    dark: {
        '--popover': '#1c1916',
        '--popover-foreground': '#eeeae6',
        '--muted-foreground': '#a39d97',
        '--accent': '#26221f',
        '--oca-hairline-strong': '#363432',
        '--input': '#6f6964',
        '--primary': '#c2410c',
        '--primary-foreground': '#ffffff',
        '--oca-cta-hover': '#cc4a0e',
        '--ring': '#f97316',
        '--oca-accent-ink': '#fb923c',
    },
} as const;

type Tokens = Record<keyof (typeof PICKER_TOKENS)['light'], string>;

function declare(tokens: Tokens): string {
    return Object.entries(tokens)
        .map(([name, value]) => `${name}:${value};`)
        .join(' ');
}

/**
 * The tokens on the shadow tree's own top elements, switched by the browser's mode. Not on
 * :host: the host is a plain div on someone else's page, and any page rule that matches it
 * (`div { --popover: … }`, `body > div`) beats a :host rule, so the panel would take the
 * page's values. No page rule reaches inside the shadow root.
 */
const TOKENS = `
    .panel, .mark { ${declare(PICKER_TOKENS.light)} }
    @media (prefers-color-scheme: dark) { .panel, .mark { ${declare(PICKER_TOKENS.dark)} } }
`;

const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** The picker and the save prompt: a square panel, a mono label head, rows, actions. */
export const PANEL_CSS = `${TOKENS}
    .panel { font:13px/1.45 ${SANS}; background:var(--popover);
        color:var(--popover-foreground); border:1px solid var(--oca-hairline-strong);
        border-radius:0; width:280px; overflow:hidden;
        box-shadow:0 12px 32px rgba(0,0,0,.22); }
    .head { display:flex; align-items:center; gap:7px; padding:9px 12px;
        border-bottom:1px solid var(--oca-hairline-strong); color:var(--muted-foreground);
        font:11px/1.4 ${MONO}; letter-spacing:.08em; text-transform:uppercase; }
    .head svg { display:block; color:var(--oca-accent-ink); }
    .head strong { color:var(--popover-foreground); font-weight:500; }
    .msg { padding:12px; color:var(--muted-foreground); line-height:1.55; }
    .who { padding:0 12px 10px; color:var(--popover-foreground); word-break:break-all; }
    .row { display:flex; align-items:center; gap:10px; width:100%; min-height:44px;
        text-align:left; cursor:pointer; background:none; border:none;
        border-bottom:1px solid var(--oca-hairline-strong); color:var(--popover-foreground);
        font:inherit; padding:10px 12px; }
    .row:last-child { border-bottom:none; }
    .row svg { color:var(--oca-accent-ink); flex-shrink:0; }
    .row:hover { background:var(--accent); }
    .row:focus-visible { background:var(--accent); outline:2px solid var(--ring);
        outline-offset:-2px; }
    .row .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .row .t { margin-left:auto; color:var(--muted-foreground); font:10px/1 ${MONO};
        letter-spacing:.08em; text-transform:uppercase; flex-shrink:0; }
    .actions { display:flex; gap:8px; padding:10px 12px;
        border-top:1px solid var(--oca-hairline-strong); }
    .act { flex:1; min-height:36px; cursor:pointer; font:inherit; font-size:12px;
        font-weight:500; padding:8px; border-radius:0; border:1px solid var(--input);
        background:none; color:var(--popover-foreground); }
    .act:hover { border-color:var(--popover-foreground); background:var(--accent); }
    .act:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
    .act-primary { background:var(--primary); color:var(--primary-foreground);
        border-color:var(--primary); }
    .act-primary:hover { background:var(--oca-cta-hover); border-color:var(--oca-cta-hover); }
`;

/** The field mark: the keyhole on a tint of the accent ink, square. */
export const MARK_CSS = `${TOKENS}
    .mark { width:22px; height:22px; padding:0; border:none; border-radius:0;
        cursor:pointer; display:flex; align-items:center; justify-content:center;
        color:var(--oca-accent-ink);
        background:color-mix(in srgb, var(--oca-accent-ink) 16%, var(--popover));
        box-shadow:0 1px 3px rgba(0,0,0,.28); transition:background .12s; }
    .mark:hover { background:color-mix(in srgb, var(--oca-accent-ink) 30%, var(--popover)); }
    .mark:focus-visible { outline:2px solid var(--ring); outline-offset:1px; }
`;
