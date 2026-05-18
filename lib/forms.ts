/**
 * Login-form detection — Phase 2 (autofill).
 *
 * This module finds username / password fields on a page so the content
 * script can offer the fill affordance. It is a STUB until Phase 2; the
 * signatures below are the contract the content script and `origin.ts`
 * are built against.
 *
 * Design constraints when this is implemented (see SECURITY.md §5):
 *  - detection only — this module never reads or writes a field value;
 *  - a field inside a cross-origin iframe is reported with its own frame
 *    origin so the worker can apply the iframe rule (SECURITY.md §4);
 *  - heuristics, not guarantees: `autocomplete` tokens first, then input
 *    `type`/`name`/`id` signals; Shadow DOM and canvas widgets are
 *    best-effort and explicitly out of the v1 guarantee.
 */

/** A detected login field on the page. */
export interface LoginField {
    /** 'username' | 'password' — what kind of field this is. */
    role: 'username' | 'password';
    /** The element, for the content script to attach an affordance to. */
    element: HTMLInputElement;
}

/** A detected login form — a username and/or password field, grouped. */
export interface LoginForm {
    fields: LoginField[];
    /** The form's frame origin — the iframe rule keys off this. */
    frameOrigin: string;
}

/**
 * Scan the current document for login forms.
 *
 * STUB — Phase 2. Returns `[]` so Phase 0–1 builds cleanly without the
 * content script doing anything on a page.
 */
export function detectLoginForms(): LoginForm[] {
    return [];
}
