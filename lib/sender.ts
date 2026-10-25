/**
 * Who sent a message to the worker, and what that sender may ask for.
 *
 * Extension pages (the popup) are trusted surfaces and may send anything. A
 * content script runs inside every page and frame, so a message from one is
 * treated as coming from that page: it may only ask for what autofill and
 * capture need, and the page it speaks for is the sender's own URL, never a
 * URL the message names (SECURITY.md §2).
 */

import type { Message } from './messaging';

export type Caller = { kind: 'extension' } | { kind: 'page'; url: string };

/** The requests a page's content script makes; everything else is popup-only. */
export const PAGE_KINDS: ReadonlySet<Message['kind']> = new Set<Message['kind']>([
    'get-state',
    'get-settings',
    'match-page',
    'fill-values',
    'capture-login',
    'get-pending-capture',
    'commit-capture',
    'dismiss-capture',
]);

export class NotAllowed extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'NotAllowed';
    }
}

/** Classify a runtime message sender, or null when it is neither of ours. */
export function callerOf(
    sender: { id?: string; url?: string; tab?: unknown },
    extensionBase: string,
    extensionId: string
): Caller | null {
    if (sender.id !== extensionId || typeof sender.url !== 'string') return null;
    if (sender.url.startsWith(extensionBase)) return { kind: 'extension' };
    if (!sender.tab) return null;
    let url: URL;
    try {
        url = new URL(sender.url);
    } catch {
        return null;
    }
    return url.protocol === 'https:' || url.protocol === 'http:'
        ? { kind: 'page', url: url.href }
        : null;
}

/** The message as the worker may act on it, or a refusal. */
export function admit(message: Message, caller: Caller | null): Message {
    if (!caller) throw new NotAllowed('unknown sender');
    if (caller.kind === 'extension') return message;
    if (!PAGE_KINDS.has(message.kind)) throw new NotAllowed('not allowed from a page');
    switch (message.kind) {
        case 'match-page':
            return { ...message, pageUrl: caller.url };
        case 'capture-login':
            return { ...message, url: caller.url };
        case 'get-pending-capture':
            return { ...message, pageUrl: caller.url };
        default:
            return message;
    }
}
