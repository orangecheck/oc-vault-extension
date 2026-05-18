/**
 * Background service worker — the trusted core (PLAN.md §2, SECURITY.md §2).
 *
 * This is the ONLY component that holds the vault key or decrypts. The
 * popup and (Phase 2) the content script reach it through `lib/messaging`;
 * they never receive the key. The key lives in this worker's memory and
 * nowhere else — and MV3 terminates this worker on idle, which drops the
 * key and re-locks the vault by design (PLAN.md §7).
 */

import {
    decryptFields,
    isLiveEntry,
    toSummary,
    unpackEntryFromCloud,
    unwrapVaultKey,
    type VaultEntry,
    type VaultEntryFields,
} from '@/lib/crypto';
import { onMessage, type VaultState } from '@/lib/messaging';
import { entryMatchesPage } from '@/lib/origin';
import { fetchBlob, fetchEscrow, listBlobs, NotSignedIn } from '@/lib/sync';

export default defineBackground(() => {
    /* ── in-memory session — never persisted (SECURITY.md §3) ──────────── */
    let key: Uint8Array | null = null;
    let entries: VaultEntry[] = [];
    let lastSyncAt: string | null = null;

    /** Decrypt one entry's fields against the held key. */
    function fieldsOf(entry: VaultEntry): VaultEntryFields {
        if (!key) throw new Error('vault is locked');
        return decryptFields(entry, key);
    }

    /** Drop the key and the decrypted index — the vault is locked again. */
    function lock(): VaultState {
        key = null;
        entries = [];
        lastSyncAt = null;
        return { status: 'locked', entryCount: 0, lastSyncAt: null };
    }

    /** Pull every blob and rebuild the decrypted entry index. */
    async function sync(): Promise<VaultState> {
        if (!key) throw new Error('vault is locked');
        const refs = await listBlobs();
        const next: VaultEntry[] = [];
        for (const ref of refs) {
            const payload = await fetchBlob(ref.envelope_id);
            if (!payload) continue;
            try {
                const entry = unpackEntryFromCloud(payload, key);
                if (isLiveEntry(entry)) next.push(entry);
            } catch {
                // a blob this key cannot decrypt — skip it, never crash sync
            }
        }
        entries = next;
        lastSyncAt = new Date().toISOString();
        return { status: 'unlocked', entryCount: entries.length, lastSyncAt };
    }

    /** Probe whether this browser has a signed-in, set-up vault. */
    async function probe(): Promise<VaultState> {
        if (key) return { status: 'unlocked', entryCount: entries.length, lastSyncAt };
        try {
            const escrow = await fetchEscrow();
            // escrow present → locked; absent → signed in but no vault yet,
            // which the popup treats the same (it links out to set up).
            return {
                status: escrow ? 'locked' : 'signed-out',
                entryCount: 0,
                lastSyncAt: null,
            };
        } catch (err) {
            if (err instanceof NotSignedIn) {
                return { status: 'signed-out', entryCount: 0, lastSyncAt: null };
            }
            throw err;
        }
    }

    onMessage(async (message) => {
        switch (message.kind) {
            case 'get-state':
                return probe();

            case 'unlock': {
                const escrow = await fetchEscrow();
                if (!escrow) throw new Error('no vault to unlock — set one up at vault.ochk.io');
                // unwrapVaultKey throws WrongPassphrase on a bad passphrase.
                key = unwrapVaultKey(escrow, message.passphrase);
                return sync();
            }

            case 'lock':
                return lock();

            case 'sync':
                return sync();

            case 'list-entries':
                // Summaries only — names, types, urls. No secret crosses here.
                return entries.map((e) => toSummary(e, fieldsOf(e)));

            case 'reveal-field': {
                const entry = entries.find((e) => e.id === message.entryId);
                if (!entry) throw new Error('entry not found');
                const value = fieldsOf(entry)[message.field];
                return { value: typeof value === 'string' ? value : '' };
            }

            case 'match-page':
                // Phase 2 (autofill) consumes this. Pure origin matching —
                // no secret in the result, only metadata summaries.
                return entries
                    .map((e) => toSummary(e, fieldsOf(e)))
                    .filter((s) => s.url && entryMatchesPage(s.url, message.pageUrl));

            default:
                throw new Error('unknown message');
        }
    });
});
