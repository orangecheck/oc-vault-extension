/**
 * What the autofill menu shows, decided from the worker's answers. Pure, so the
 * decision is tested without a page (content.ts draws the result).
 *
 * The menu opens two ways. Focusing a login field opens it on its own
 * (`auto`): then anything but a list of logins closes it without a word, so a
 * page is never disturbed. Clicking the OC mark opens it on purpose: then an
 * empty or failed result is explained.
 *
 * A page learns only the lock state from the worker; the entry count it gets
 * is always 0 (lib/sender.ts). So the menu never reads the count: an unlocked
 * vault is always asked for this page's logins.
 */

import type { VaultEntrySummary } from './crypto';
import type { VaultState } from './messaging';

export type PickerOutcome =
    | { kind: 'close' }
    | { kind: 'message'; text: string }
    | { kind: 'list'; matches: VaultEntrySummary[] };

export const PICKER_TEXT = {
    locked: 'OC Vault is locked — click the OC icon in your browser toolbar to unlock it.',
    signedOut: 'Sign in to your orangecheck account, then open OC Vault from the toolbar.',
    noMatch: 'No saved logins for this site.',
    failed: 'Could not reach the vault.',
} as const;

const quietly = (auto: boolean, text: string): PickerOutcome =>
    auto ? { kind: 'close' } : { kind: 'message', text };

/** After the lock state: 'ask' for this page's logins, or what to show instead. */
export function afterState(state: VaultState, auto: boolean): PickerOutcome | 'ask' {
    if (state.status === 'unlocked') return 'ask';
    return quietly(auto, state.status === 'locked' ? PICKER_TEXT.locked : PICKER_TEXT.signedOut);
}

/**
 * After this page's logins. `stillFocused` is false when focus has moved off the
 * field since an auto-open, which then closes rather than popping up elsewhere.
 */
export function afterMatches(
    matches: VaultEntrySummary[],
    auto: boolean,
    stillFocused: boolean
): PickerOutcome {
    if (matches.length === 0) return quietly(auto, PICKER_TEXT.noMatch);
    if (auto && !stillFocused) return { kind: 'close' };
    return { kind: 'list', matches };
}

/** The worker did not answer. */
export function onFailure(auto: boolean): PickerOutcome {
    return quietly(auto, PICKER_TEXT.failed);
}
