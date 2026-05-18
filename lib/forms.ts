/**
 * Login-form detection.
 *
 * Finds the username / password fields on a page so the content script can
 * offer the fill affordance. Detection ONLY — this module never reads or
 * writes a field value (SECURITY.md §5). Heuristics, not guarantees:
 * `autocomplete` tokens first, then `type`, then name / id / aria hints.
 * Shadow-DOM and canvas login widgets are out of the v1 guarantee.
 *
 * Each detected form carries its own frame's origin — the content script
 * runs per-frame, so a field in a cross-origin iframe is matched against
 * that iframe's origin, never the parent's (SECURITY.md §4, the iframe rule).
 */

/** A detected login field on the page. */
export interface LoginField {
    role: 'username' | 'password';
    element: HTMLInputElement;
}

/** A detected login form — a password field, with its username when found. */
export interface LoginForm {
    fields: LoginField[];
    /** The frame origin this form lives in. */
    frameOrigin: string;
}

const USERNAME_HINT = /user|email|login|account|signin/i;

function isVisible(el: HTMLElement): boolean {
    if (el.hidden) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

/** A text-ish input that could hold a username. */
function isUsernameCandidate(el: HTMLInputElement): boolean {
    const type = (el.type || 'text').toLowerCase();
    return type === 'text' || type === 'email' || type === 'tel';
}

/** The form, or the document, an input belongs to. */
function scopeOf(input: HTMLInputElement): HTMLElement | Document {
    return input.form ?? input.ownerDocument;
}

/** Find the username field paired with a password field, or null. */
function findUsername(password: HTMLInputElement): HTMLInputElement | null {
    const scope = scopeOf(password);
    const candidates = Array.from(scope.querySelectorAll<HTMLInputElement>('input')).filter(
        (i) => i !== password && isUsernameCandidate(i) && isVisible(i)
    );
    if (candidates.length === 0) return null;

    // 1. an explicit autocomplete / email signal.
    const byHint = candidates.find(
        (i) => /username|email/i.test(i.autocomplete) || i.type.toLowerCase() === 'email'
    );
    if (byHint) return byHint;

    // 2. a name / id / aria-label that reads like a username.
    const byName = candidates.find((i) =>
        USERNAME_HINT.test(`${i.name} ${i.id} ${i.getAttribute('aria-label') ?? ''}`)
    );
    if (byName) return byName;

    // 3. fall back to the last text field before the password in DOM order.
    const all = Array.from(password.ownerDocument.querySelectorAll('input'));
    const pwIndex = all.indexOf(password);
    const before = candidates.filter((i) => all.indexOf(i) < pwIndex);
    return before.length > 0 ? before[before.length - 1]! : candidates[0]!;
}

/** Scan the current document for login forms. */
export function detectLoginForms(): LoginForm[] {
    if (typeof document === 'undefined') return [];
    const passwords = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="password"]')
    ).filter((el) => !el.disabled && isVisible(el));

    return passwords.map((password) => {
        const fields: LoginField[] = [{ role: 'password', element: password }];
        const username = findUsername(password);
        if (username) fields.unshift({ role: 'username', element: username });
        return { fields, frameOrigin: location.origin };
    });
}
