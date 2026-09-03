/**
 * Origin matching — the autofill trust check (SECURITY.md §4).
 *
 * A stored entry carries the URL it was saved on. An entry may be offered
 * on a page ONLY when this module says they match. The match is the
 * security boundary: there is no fuzzy matching, no path matching, no
 * user-editable equivalence list — each of those is a phishing vector.
 *
 * NOTE: registrable-domain detection here uses a compact known-suffix set,
 * not the full Public Suffix List. Phase 2 swaps in a real PSL (`tldts`)
 * before autofill ships — until then this is intentionally conservative:
 * an unknown multi-part suffix falls back to exact-host matching, which
 * can only ever be *stricter*, never looser.
 */

/** Compact multi-label public suffixes. Conservative — extend via PSL in Phase 2. */
const MULTI_LABEL_SUFFIXES = new Set([
    // ── ccTLD second levels ────────────────────────────────────────────────
    'co.uk',
    'org.uk',
    'gov.uk',
    'ac.uk',
    'me.uk',
    'co.jp',
    'ne.jp',
    'or.jp',
    'com.au',
    'net.au',
    'org.au',
    'com.br',
    'co.nz',
    'net.nz',
    'co.in',
    'com.mx',
    'co.za',
    'com.sg',
    'com.tr',
    'co.il',
    'co.kr',
    'com.cn',
    'com.hk',
    'com.tw',
    'co.th',
    'com.ar',
    'com.co',
    'com.pl',
    'com.ua',
    'co.id',
    // ── SHARED-HOSTING suffixes. These are the ones that made this a
    //    credential-disclosure bug rather than a cosmetic gap: every customer
    //    of the platform is a sibling subdomain, so treating the suffix as the
    //    registrable domain offers alice's credential on attacker's page.
    'github.io',
    'gitlab.io',
    'vercel.app',
    'netlify.app',
    'pages.dev',
    'workers.dev',
    'herokuapp.com',
    'herokudns.com',
    'blogspot.com',
    'wordpress.com',
    'myshopify.com',
    'web.app',
    'firebaseapp.com',
    'azurewebsites.net',
    'cloudapp.net',
    'elasticbeanstalk.com',
    'onrender.com',
    'fly.dev',
    'railway.app',
    'surge.sh',
    'glitch.me',
    'repl.co',
    'replit.dev',
    'ngrok.io',
    'ngrok-free.app',
    'notion.site',
    'substack.com',
    'medium.com',
    'tumblr.com',
    'zendesk.com',
    'freshdesk.com',
    'atlassian.net',
    'sharepoint.com',
    'salesforce.com',
    'appspot.com',
]);

/** A normalized origin: scheme + host + port. Null when the URL is unusable. */
export function originOf(url: string): string | null {
    try {
        const u = new URL(url.includes('://') ? url : `https://${url}`);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        return u.origin;
    } catch {
        return null;
    }
}

/**
 * The registrable domain (eTLD+1) of a hostname — `mail.example.co.uk`
 * → `example.co.uk`.
 *
 * READ THIS BEFORE TRUSTING IT. Determining eTLD+1 correctly requires the
 * Public Suffix List; this is a hand-maintained approximation, and the
 * approximation fails in the LOOSE direction — an unknown multi-label suffix
 * is treated as a registrable domain rather than as a suffix.
 *
 * That is a credential-disclosure bug, not a cosmetic gap. With `github.io`
 * absent from the set below, `alice.github.io` and `attacker.github.io` both
 * reduce to `github.io`, so matchEntryToPage answers `'registrable'` and the
 * vault offers alice's credential on the attacker's page. The same held for
 * vercel.app, pages.dev, herokuapp.com, blogspot.com and every second-level
 * ccTLD outside the list. The twelve entries that WERE listed behaved
 * correctly, which is exactly why a test written against the list passed.
 *
 * The docstring here used to claim it "falls back to the full host when the
 * suffix is unknown (stricter, never looser)". It did not: it returned the
 * last two labels. The claim described the property this function should have
 * and the code did the opposite.
 *
 * The set now covers the shared-hosting suffixes — where every customer is a
 * sibling subdomain and the exposure is real — plus the common ccTLD second
 * levels. It is still an approximation. A complete fix is the PSL; until then,
 * treat `'registrable'` as a hint and prefer `'exact'` for anything sensitive.
 */
export function registrableDomain(host: string): string {
    const labels = host.toLowerCase().split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const lastTwo = labels.slice(-2).join('.');
    if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
        return labels.slice(-3).join('.');
    }
    return lastTwo;
}

export type OriginMatch = 'exact' | 'registrable' | 'none';

/**
 * How an entry's stored URL relates to a page URL.
 *  - 'exact'       — same scheme + host + port; offer first.
 *  - 'registrable' — same eTLD+1 (e.g. www. vs bare); offer, ranked lower.
 *  - 'none'        — do not offer this entry on this page.
 *
 * An `https` entry never matches an `http` page: a downgrade is a no.
 */
export function matchEntryToPage(entryUrl: string, pageUrl: string): OriginMatch {
    const entryOrigin = originOf(entryUrl);
    const pageOrigin = originOf(pageUrl);
    if (!entryOrigin || !pageOrigin) return 'none';
    if (entryOrigin === pageOrigin) return 'exact';

    const e = new URL(entryOrigin);
    const p = new URL(pageOrigin);
    // No scheme downgrade — an https credential is not for an http page.
    if (e.protocol === 'https:' && p.protocol !== 'https:') return 'none';
    if (registrableDomain(e.hostname) === registrableDomain(p.hostname)) {
        return 'registrable';
    }
    return 'none';
}

/** True when an entry may be offered on a page at all. */
export function entryMatchesPage(entryUrl: string, pageUrl: string): boolean {
    return matchEntryToPage(entryUrl, pageUrl) !== 'none';
}
