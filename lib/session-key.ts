/**
 * Surviving the MV3 service-worker lifecycle.
 *
 * Chrome terminates the background worker after ~30s idle. If the vault key
 * lived only in that worker's `let`, every new page would force a fresh
 * passphrase — unusable. So while the vault is unlocked the key is mirrored
 * into `browser.storage.session`:
 *
 *   - it is held **in memory**, never written to disk;
 *   - it outlives a single worker instance, so the worker can restore the
 *     key when Chrome wakes it again;
 *   - it is wiped when the browser closes (a browser restart re-locks);
 *   - content scripts cannot read it — `storage.session`'s default access
 *     level is trusted contexts only.
 *
 * The vault still re-locks: the idle-lock alarm and an explicit lock both
 * clear this (see `background.ts`). This is the extension's equivalent of
 * oc-vault-web's in-tab `sessionStorage` hold — RAM-scoped, not at rest.
 */

import { b64urlDecode, b64urlEncode } from '@orangecheck/lock-crypto';

const SLOT = 'oc-session-key';

/** Mirror the unlocked key into the in-memory session store. */
export async function persistSessionKey(key: Uint8Array): Promise<void> {
    await browser.storage.session.set({ [SLOT]: b64urlEncode(key) });
}

/** Restore the key after a worker restart, or null if none / locked. */
export async function restoreSessionKey(): Promise<Uint8Array | null> {
    const got = await browser.storage.session.get(SLOT);
    const raw = got[SLOT];
    if (typeof raw !== 'string') return null;
    try {
        const key = b64urlDecode(raw);
        return key.length === 32 ? key : null;
    } catch {
        return null;
    }
}

/** Drop the mirrored key — the vault is locked again. */
export async function clearSessionKey(): Promise<void> {
    await browser.storage.session.remove(SLOT);
}
