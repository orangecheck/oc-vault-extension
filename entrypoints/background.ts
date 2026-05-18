/**
 * Background service worker — the trusted core (PLAN.md §2, SECURITY.md §2).
 *
 * The ONLY component that holds the vault key or decrypts. The popup and
 * (Phase 2) the content script reach it through `lib/messaging`; they never
 * receive the key. The key lives in this worker's memory and nowhere else.
 *
 * Two ways the vault re-locks (PLAN.md §7): MV3 terminates this worker on
 * idle — the key dies with it — and, while the worker is alive, an idle
 * alarm drops the key after the configured timeout.
 */

import { readBlobCache, writeBlobCache, type CachedBlob } from '@/lib/cache';
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
import { loadSettings, saveSettings, type Settings } from '@/lib/settings';

const IDLE_ALARM = 'oc-idle-lock';

export default defineBackground(() => {
    /* ── in-memory session — never persisted (SECURITY.md §3) ──────────── */
    let key: Uint8Array | null = null;
    let entries: VaultEntry[] = [];
    let lastSyncAt: string | null = null;
    let settings: Settings | null = null;

    async function getSettings(): Promise<Settings> {
        if (!settings) settings = await loadSettings();
        return settings;
    }

    /** Decrypt one entry's fields against the held key. */
    function fieldsOf(entry: VaultEntry): VaultEntryFields {
        if (!key) throw new Error('vault is locked');
        return decryptFields(entry, key);
    }

    function state(status: VaultState['status']): VaultState {
        return {
            status,
            entryCount: status === 'unlocked' ? entries.length : 0,
            lastSyncAt: status === 'unlocked' ? lastSyncAt : null,
        };
    }

    /* ── idle lock (PLAN.md §7) ─────────────────────────────────────────── */

    /** Arm the idle-lock alarm for the configured timeout. 0 = never. */
    async function armIdleLock(): Promise<void> {
        await browser.alarms.clear(IDLE_ALARM);
        const { idleLockMinutes } = await getSettings();
        if (idleLockMinutes > 0) {
            browser.alarms.create(IDLE_ALARM, { delayInMinutes: idleLockMinutes });
        }
    }

    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === IDLE_ALARM) lock();
    });

    /** Drop the key and the decrypted index — the vault is locked again. */
    function lock(): VaultState {
        key = null;
        entries = [];
        lastSyncAt = null;
        void browser.alarms.clear(IDLE_ALARM);
        return state('locked');
    }

    /* ── sync ───────────────────────────────────────────────────────────── */

    /** Decrypt a set of cached/fetched blobs into the live entry index. */
    function indexFromBlobs(blobs: CachedBlob[]): VaultEntry[] {
        if (!key) return [];
        const next: VaultEntry[] = [];
        for (const blob of blobs) {
            try {
                const entry = unpackEntryFromCloud(blob.ciphertext, key);
                if (isLiveEntry(entry)) next.push(entry);
            } catch {
                // a blob this key cannot decrypt (wrong key / stale cache) — skip
            }
        }
        return next;
    }

    /** Pull every blob from the server, rebuild the index, refresh the cache. */
    async function sync(): Promise<VaultState> {
        if (!key) throw new Error('vault is locked');
        const refs = await listBlobs();
        const blobs: CachedBlob[] = [];
        for (const ref of refs) {
            const ciphertext = await fetchBlob(ref.envelope_id);
            if (ciphertext) {
                blobs.push({
                    envelope_id: ref.envelope_id,
                    updated_at: ref.updated_at,
                    ciphertext,
                });
            }
        }
        entries = indexFromBlobs(blobs);
        lastSyncAt = new Date().toISOString();
        // Cache is ciphertext only — safe at rest (SECURITY.md §1).
        await writeBlobCache(blobs);
        return state('unlocked');
    }

    /** Probe whether this browser has a signed-in, set-up vault. */
    async function probe(): Promise<VaultState> {
        if (key) return state('unlocked');
        try {
            const escrow = await fetchEscrow();
            return state(escrow ? 'locked' : 'signed-out');
        } catch (err) {
            if (err instanceof NotSignedIn) return state('signed-out');
            throw err;
        }
    }

    onMessage(async (message) => {
        // Any interaction with an unlocked vault defers the idle lock.
        if (key && message.kind !== 'get-state') void armIdleLock();

        switch (message.kind) {
            case 'get-state':
                return probe();

            case 'unlock': {
                const escrow = await fetchEscrow();
                if (!escrow) throw new Error('no vault to unlock — set one up at vault.ochk.io');
                // unwrapVaultKey throws WrongPassphrase on a bad passphrase.
                key = unwrapVaultKey(escrow, message.passphrase);
                await armIdleLock();
                // Instant first paint from the ciphertext cache; the popup
                // follows up with a 'sync' to refresh from the server.
                entries = indexFromBlobs(await readBlobCache());
                return state('unlocked');
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

            case 'reveal-entry': {
                const entry = entries.find((e) => e.id === message.entryId);
                if (!entry) throw new Error('entry not found');
                return { fields: fieldsOf(entry) };
            }

            case 'get-settings':
                return getSettings();

            case 'set-settings':
                settings = message.settings;
                await saveSettings(settings);
                if (key) await armIdleLock();
                return settings;

            case 'match-page':
                // Autofill: the origin-matched subset only — metadata
                // summaries, no secret (SECURITY.md §4).
                return entries
                    .map((e) => toSummary(e, fieldsOf(e)))
                    .filter((s) => s.url && entryMatchesPage(s.url, message.pageUrl));

            case 'fill-values': {
                // Resolve the requested fields of ONE entry the user picked.
                // Only those values, only that entry — never the key, never
                // another entry (SECURITY.md §3, invariant 2).
                const entry = entries.find((e) => e.id === message.entryId);
                if (!entry) throw new Error('entry not found');
                const all = fieldsOf(entry);
                const values: Record<string, string> = {};
                for (const name of message.fields) {
                    const v = all[name];
                    if (typeof v === 'string') values[name] = v;
                }
                return { values };
            }

            default:
                throw new Error('unknown message');
        }
    });
});
