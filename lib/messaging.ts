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

import type { VaultEntrySummary } from './crypto';

/** The worker's lock state, safe to share with any surface. */
export interface VaultState {
    status: 'signed-out' | 'locked' | 'unlocked';
    /** Entry count when unlocked — metadata, not a secret. */
    entryCount: number;
    /** ISO timestamp of the last successful sync, when known. */
    lastSyncAt: string | null;
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
    /** Content-script: which entries match this page (summaries only). */
    | { kind: 'match-page'; pageUrl: string };

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
    'match-page': VaultEntrySummary[];
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
