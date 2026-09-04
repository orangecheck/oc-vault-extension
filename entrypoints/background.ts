/**
 * Background service worker — the trusted core (PLAN.md §2, SECURITY.md §2).
 *
 * The ONLY component that holds the vault key or decrypts. The popup and
 * the content script reach it through `lib/messaging`; they never receive
 * the key.
 *
 * MV3 terminates this worker on idle. So while the vault is unlocked the
 * key is mirrored into `storage.session` — RAM, never disk (see
 * `lib/session-key`) — and restored on the next wake, so the vault does
 * not re-lock on every new page. It re-locks only on the idle-lock alarm,
 * an explicit lock, or a browser restart (PLAN.md §7).
 */

import { readBlobCache, writeBlobCache, type CachedBlob } from '@/lib/cache';
import {
    decryptFields,
    encryptFields,
    generateEntryId,
    isLiveEntry,
    packEntryForCloud,
    toSummary,
    unpackEntryFromCloud,
    unwrapVaultKey,
    type VaultEntry,
    type VaultEntryFields,
} from '@/lib/crypto';
import { onMessage, type VaultState } from '@/lib/messaging';
// Origin matching is a SECURITY BOUNDARY, so it lives in one place.
// lib/origin.ts was a copy of vault-core's — behaviourally identical, but a
// copy of a security check is a copy you have to remember to fix twice, and
// registrableDomain has already had a real cross-tenant bug once.
import { entryMatchesPage, matchEntryToPage } from '@orangecheck/vault-core';
import { clearSessionKey, persistSessionKey, restoreSessionKey } from '@/lib/session-key';
import {
    fetchBlobs,
    fetchEscrow,
    fetchIdentity,
    listBlobs,
    NotSignedIn,
    putBlob,
} from '@/lib/sync';
import { loadSettings, saveSettings, type Settings } from '@/lib/settings';

const IDLE_ALARM = 'oc-idle-lock';
const CAPTURE_TTL_MS = 2 * 60_000;
/** storage.session slot for the pending capture — RAM-only, survives a
 *  worker restart so a save prompt is not lost (SECURITY.md §3). */
const PENDING_SLOT = 'oc-pending-capture';

/** A login the user just submitted, awaiting a save/update confirmation.
 *  Holds a password → in-memory only, never persisted (SECURITY.md §3). */
interface PendingCapture {
    url: string;
    host: string;
    username: string;
    password: string;
    mode: 'new' | 'update';
    entryId?: string;
    at: number;
}

export default defineBackground(() => {
    /* ── in-memory session — never persisted (SECURITY.md §3) ──────────── */
    let key: Uint8Array | null = null;
    let entries: VaultEntry[] = [];
    let lastSyncAt: string | null = null;
    let settings: Settings | null = null;
    let pendingCapture: PendingCapture | null = null;
    /** The signed-in OC identity (`did:oc:…`) — surfaced so a "0 entries"
     *  vault that belongs to a different identity is visible, not a mystery. */
    let identity: string | null = null;
    let identityFetched = false;

    /** Fetch the signed-in identity once per worker instance. */
    async function ensureIdentity(): Promise<void> {
        if (identityFetched) return;
        identityFetched = true;
        try {
            identity = await fetchIdentity();
        } catch {
            identity = null;
        }
    }

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
            identity,
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

    /** Set the pending capture, mirroring it into RAM-only session storage
     *  so a worker restart between the prompt and the save does not lose it. */
    function setPending(pc: PendingCapture | null): void {
        pendingCapture = pc;
        if (pc) void browser.storage.session.set({ [PENDING_SLOT]: pc });
        else void browser.storage.session.remove(PENDING_SLOT);
    }

    /** Drop the key and the decrypted index — the vault is locked again. */
    function lock(): VaultState {
        key = null;
        entries = [];
        lastSyncAt = null;
        setPending(null);
        void clearSessionKey();
        void browser.alarms.clear(IDLE_ALARM);
        return state('locked');
    }

    /* ── capture (PLAN.md §6) ───────────────────────────────────────────── */

    /** Write the held pending capture to the vault as a new / updated entry. */
    async function commitCapture(): Promise<void> {
        if (!key) throw new Error('vault is locked');
        const pc = pendingCapture;
        if (!pc) throw new Error('nothing to save');
        const now = new Date().toISOString();

        if (pc.mode === 'update' && pc.entryId) {
            const existing = entries.find((e) => e.id === pc.entryId);
            if (!existing) throw new Error('the entry to update is gone — sync and retry');
            const fields = decryptFields(existing, key);
            fields.password = pc.password;
            if (pc.username) fields.username = pc.username;
            const sealed = encryptFields(fields, key);
            const updated: VaultEntry = { ...existing, ...sealed, updated_at: now };
            await putBlob(updated.id, packEntryForCloud(updated, key));
            entries = entries.map((e) => (e.id === updated.id ? updated : e));
        } else {
            const id = generateEntryId();
            const fields: VaultEntryFields = {
                username: pc.username,
                password: pc.password,
                url: pc.url,
            };
            const sealed = encryptFields(fields, key);
            const entry: VaultEntry = {
                id,
                type: 'password',
                name: pc.host,
                ...sealed,
                created_at: now,
                updated_at: now,
            };
            await putBlob(id, packEntryForCloud(entry, key));
            entries = [...entries, entry];
        }
        setPending(null);
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

    /**
     * Sync — a DELTA pull, not a full re-fetch.
     *
     * The manifest (`/api/blobs`) carries every blob's `updated_at`. A blob
     * whose `updated_at` matches the ciphertext cache is reused as-is; only
     * new / changed blobs are fetched (with bounded concurrency). So a full
     * vault is pulled once, and every later sync does almost no network —
     * the old code re-fetched all N blobs every time, which on a large
     * vault was slow and tripped the server rate limit, starving the sync.
     * Blobs absent from the manifest (deleted) fall out naturally.
     */
    async function sync(): Promise<VaultState> {
        if (!key) throw new Error('vault is locked');
        const refs = await listBlobs();
        const cached = new Map((await readBlobCache()).map((b) => [b.envelope_id, b]));
        const reused: CachedBlob[] = [];
        const stale: typeof refs = [];
        for (const ref of refs) {
            const hit = cached.get(ref.envelope_id);
            if (hit && hit.updated_at === ref.updated_at) reused.push(hit);
            else stale.push(ref);
        }
        const fetched = await fetchBlobs(stale);
        const blobs: CachedBlob[] = [...reused, ...fetched];
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

    /* ── restore across a worker restart (PLAN.md §7) ───────────────────── */

    let restoreAttempted = false;
    let restorePromise: Promise<void> | null = null;

    /**
     * MV3 terminates this worker on idle; on the next wake the key is gone.
     * Restore it from `storage.session` (still unlocked, just a fresh
     * worker) before the first message is handled, and rehydrate the entry
     * index from the ciphertext cache so autofill works immediately. Runs
     * at most once per worker instance.
     */
    function ensureRestored(): Promise<void> {
        if (restoreAttempted || key) return Promise.resolve();
        if (!restorePromise) {
            restorePromise = (async () => {
                const restored = await restoreSessionKey();
                if (restored) {
                    key = restored;
                    entries = indexFromBlobs(await readBlobCache());
                    void sync().catch(() => undefined); // refresh from the server
                }
                // A pending capture also survives the worker restart — it is
                // RAM-only (storage.session), the same posture as the key.
                const stored = (await browser.storage.session.get(PENDING_SLOT))[PENDING_SLOT];
                if (stored) pendingCapture = stored as PendingCapture;
                restoreAttempted = true;
            })();
        }
        return restorePromise;
    }

    onMessage(async (message) => {
        // A fresh worker restores the unlocked key before anything else.
        await ensureRestored();
        await ensureIdentity();
        // Any interaction with an unlocked vault defers the idle lock.
        if (key) void armIdleLock();

        switch (message.kind) {
            case 'get-state':
                return probe();

            case 'unlock': {
                const escrow = await fetchEscrow();
                if (!escrow) throw new Error('no vault to unlock — set one up at vault.ochk.io');
                // unwrapVaultKey throws WrongPassphrase on a bad passphrase.
                key = unwrapVaultKey(escrow, message.passphrase);
                // Mirror the key so it survives worker restarts (PLAN.md §7).
                await persistSessionKey(key);
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

            case 'match-page': {
                // Autofill: the origin-matched subset only — metadata
                // summaries, no secret (SECURITY.md §4).
                const all = entries
                    .map((e) => toSummary(e, fieldsOf(e)))
                    .filter((s) => s.url && entryMatchesPage(s.url, message.pageUrl));
                // Dedupe: multiple entries with the same name + type for the
                // same site are a common artefact of accidental re-saves —
                // collapse them to one row. A favorite wins; otherwise the
                // first occurrence. The full vault stays intact (the popup
                // still lists every entry); the autofill dropdown is just
                // tidied.
                const groups = new Map<string, (typeof all)[number]>();
                for (const s of all) {
                    const key = `${s.name.toLowerCase()}|${s.type}`;
                    const prev = groups.get(key);
                    if (!prev || (s.favorite && !prev.favorite)) groups.set(key, s);
                }
                return [...groups.values()];
            }

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

            case 'capture-login': {
                // The user typed these into the page's OWN fields — the page
                // already holds them, so capturing is no new exposure
                // (SECURITY.md §5). Locked → nothing to compare against.
                if (!key || !message.password) {
                    return { decision: 'none', host: '', username: '' };
                }
                let host = '';
                try {
                    host = new URL(message.url).hostname;
                } catch {
                    return { decision: 'none', host: '', username: '' };
                }
                let mode: 'new' | 'update' = 'new';
                let entryId: string | undefined;
                for (const entry of entries) {
                    const f = decryptFields(entry, key);
                    if (typeof f.url !== 'string' || !entryMatchesPage(f.url, message.url)) {
                        continue;
                    }
                    // The password is already in the vault for this site —
                    // nothing changed, so don't prompt (regardless of which
                    // entry / username it is stored under).
                    if (f.password === message.password) {
                        return { decision: 'none', host, username: message.username };
                    }
                    // Same username, a different password → update that entry.
                    const stored = typeof f.username === 'string' ? f.username : '';
                    if (stored === message.username) {
                        mode = 'update';
                        entryId = entry.id;
                        break;
                    }
                }
                setPending({
                    url: message.url,
                    host,
                    username: message.username,
                    password: message.password,
                    mode,
                    entryId,
                    at: Date.now(),
                });
                return { decision: mode, host, username: message.username };
            }

            case 'get-pending-capture': {
                if (!pendingCapture) return { pending: null };
                if (Date.now() - pendingCapture.at > CAPTURE_TTL_MS) {
                    setPending(null);
                    return { pending: null };
                }
                // A content script (pageUrl given) sees the pending capture
                // only on the same registrable domain as the login; the
                // popup (no pageUrl — trusted) sees it unconditionally.
                if (
                    message.pageUrl &&
                    matchEntryToPage(pendingCapture.url, message.pageUrl) === 'none'
                ) {
                    return { pending: null };
                }
                return {
                    pending: {
                        mode: pendingCapture.mode,
                        host: pendingCapture.host,
                        username: pendingCapture.username,
                    },
                };
            }

            case 'commit-capture':
                if (!key) {
                    // Can't encrypt while locked. Open the popup so the user
                    // can unlock + confirm in the trusted surface — the
                    // passphrase must never transit a page (SECURITY.md §1).
                    try {
                        await browser.action.openPopup();
                    } catch {
                        // openPopup needs a recent gesture / Chrome 127+ —
                        // the popup still surfaces the pending capture on open.
                    }
                    throw new Error('locked');
                }
                await commitCapture();
                return { saved: true };

            case 'dismiss-capture':
                setPending(null);
                return {};

            default:
                throw new Error('unknown message');
        }
    });
});
