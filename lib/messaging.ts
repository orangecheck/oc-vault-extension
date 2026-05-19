/**
 * Typed message bus — popup / content script ⇄ background service worker.
 *
 * Every message crosses a trust boundary (SECURITY.md §2) and is treated
 * as attacker-influenced on receipt. The hard rule (SECURITY.md §3,
 * invariant 2): a message TO the content script never carries the vault
 * key, the entry index, or any entry the user did not gesture to fill.
 * The response types below encode that — the content script's only
 * inbound secret is a single resolved field value in `FillPayload`.
 */

import type { VaultEntryFields, VaultEntrySummary } from './crypto';
import type { Settings } from './settings';

/** The worker's lock state, safe to share with any surface. */
export interface VaultState {
    status: 'signed-out' | 'locked' | 'unlocked';
    /** Entry count when unlocked — metadata, not a secret. */
    entryCount: number;
    /** ISO timestamp of the last successful sync, when known. */
    lastSyncAt: string | null;
    /** The signed-in OrangeCheck identity (`did:oc:…`), or null. */
    identity: string | null;
}

/** Exactly what the content script receives to perform one fill. */
export interface FillPayload {
    /** The field this value targets, e.g. 'username' | 'password'. */
    field: string;
    /** The single resolved value. The only secret the content script sees. */
    value: string;
}

/** Requests the popup or content script send to the worker. */
export type Message =
    | { kind: 'get-state' }
    | { kind: 'unlock'; passphrase: string }
    | { kind: 'lock' }
    | { kind: 'sync' }
    | { kind: 'list-entries' }
    /** Popup-only: reveal one decrypted field of one entry. */
    | { kind: 'reveal-field'; entryId: string; field: string }
    /** Popup-only: reveal every decrypted field of one entry (detail view). */
    | { kind: 'reveal-entry'; entryId: string }
    | { kind: 'get-settings' }
    | { kind: 'set-settings'; settings: Settings }
    /** Content-script: which entries match this page (summaries only). */
    | { kind: 'match-page'; pageUrl: string }
    /**
     * Content-script: resolve the requested fields of ONE picked entry for
     * a fill. The reply carries only those field values for that one
     * entry — never the key, never another entry (SECURITY.md §3).
     */
    | { kind: 'fill-values'; entryId: string; fields: string[] }
    /**
     * Content-script: a login was just submitted — the user typed these
     * values into the page's own fields. The worker decides whether they
     * are new / changed and holds them as a pending capture (PLAN.md §6).
     */
    | { kind: 'capture-login'; url: string; username: string; password: string }
    /**
     * Is there a pending capture? With `pageUrl` (content script) it is
     * returned only when the page's registrable domain matches the
     * capture; without it (the popup, a trusted surface) it is returned
     * unconditionally.
     */
    | { kind: 'get-pending-capture'; pageUrl?: string }
    /** Write the pending capture to the vault. */
    | { kind: 'commit-capture' }
    /** Discard the pending capture. */
    | { kind: 'dismiss-capture' };

/** What the popup / content script needs to prompt about a capture. */
export interface PendingCaptureInfo {
    mode: 'new' | 'update';
    host: string;
    username: string;
}

/** The worker's reply. `data` shape depends on the request `kind`. */
export type Reply = { ok: true; data?: unknown } | { ok: false; reason: string };

/** Typed `data` payloads, by request kind, for the caller to narrow. */
export interface ReplyData {
    'get-state': VaultState;
    unlock: VaultState;
    lock: VaultState;
    sync: VaultState;
    'list-entries': VaultEntrySummary[];
    'reveal-field': { value: string };
    'reveal-entry': { fields: VaultEntryFields };
    'get-settings': Settings;
    'set-settings': Settings;
    'match-page': VaultEntrySummary[];
    'fill-values': { values: Record<string, string> };
    'capture-login': { decision: 'none' | 'new' | 'update'; host: string; username: string };
    'get-pending-capture': { pending: PendingCaptureInfo | null };
    'commit-capture': { saved: boolean };
    'dismiss-capture': Record<string, never>;
}

/** Send a message to the worker and await its typed reply. */
export async function send<K extends Message['kind']>(
    message: Extract<Message, { kind: K }>
): Promise<ReplyData[K]> {
    const reply = (await browser.runtime.sendMessage(message)) as Reply;
    if (!reply || reply.ok === false) {
        throw new Error(reply?.reason ?? 'no response from the vault worker');
    }
    return reply.data as ReplyData[K];
}

/**
 * Register the worker's message handler. The handler returns the reply
 * `data`, or throws — `onMessage` wraps both into the `Reply` envelope.
 */
export function onMessage(
    handler: (message: Message, sender: chrome.runtime.MessageSender) => Promise<unknown>
): void {
    browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
        const message = raw as Message;
        handler(message, sender)
            .then((data) => sendResponse({ ok: true, data } satisfies Reply))
            .catch((err: unknown) =>
                sendResponse({
                    ok: false,
                    reason: err instanceof Error ? err.message : 'worker error',
                } satisfies Reply)
            );
        // Keep the message channel open for the async response.
        return true;
    });
}
