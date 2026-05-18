/**
 * Ciphertext blob cache — `storage.local`.
 *
 * Holds only the double-encrypted blobs the server already has, so caching
 * them locally leaks nothing (SECURITY.md §1; PLAN.md §4). It lets a cold
 * popup — after the MV3 service worker was terminated — decrypt instantly
 * on unlock instead of re-fetching every blob over the network; a fresh
 * sync still runs to catch changes.
 *
 * Decrypted entries are NEVER cached (SECURITY.md §3, invariant 3).
 */

export interface CachedBlob {
    envelope_id: string;
    updated_at: string;
    /** The packed, double-encrypted blob — opaque ciphertext. */
    ciphertext: string;
}

const STORE_KEY = 'oc-blob-cache';

export async function readBlobCache(): Promise<CachedBlob[]> {
    const got = await browser.storage.local.get(STORE_KEY);
    const raw = got[STORE_KEY];
    return Array.isArray(raw) ? (raw as CachedBlob[]) : [];
}

export async function writeBlobCache(blobs: CachedBlob[]): Promise<void> {
    await browser.storage.local.set({ [STORE_KEY]: blobs });
}

export async function clearBlobCache(): Promise<void> {
    await browser.storage.local.remove(STORE_KEY);
}
