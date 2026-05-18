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
    'co.uk',
    'org.uk',
    'gov.uk',
    'ac.uk',
    'co.jp',
    'com.au',
    'com.br',
    'co.nz',
    'co.in',
    'com.mx',
    'co.za',
    'com.sg',
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
 * → `example.co.uk`. Falls back to the full host when the suffix is
 * unknown (stricter, never looser).
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
