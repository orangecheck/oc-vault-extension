/**
 * Extension settings — persisted in `storage.local`. Non-secret only;
 * a secret never lands here (SECURITY.md §3, invariant 3).
 */

export interface Settings {
    /** Auto-lock the vault after this many idle minutes. 0 = never. */
    idleLockMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = { idleLockMinutes: 15 };

/** Selectable idle-lock durations, in minutes; 0 = never. */
export const IDLE_LOCK_CHOICES = [5, 15, 30, 60, 0] as const;

const STORE_KEY = 'oc-settings';

export async function loadSettings(): Promise<Settings> {
    const got = await browser.storage.local.get(STORE_KEY);
    const raw = got[STORE_KEY] as Partial<Settings> | undefined;
    return {
        idleLockMinutes:
            typeof raw?.idleLockMinutes === 'number'
                ? raw.idleLockMinutes
                : DEFAULT_SETTINGS.idleLockMinutes,
    };
}

export async function saveSettings(settings: Settings): Promise<void> {
    await browser.storage.local.set({ [STORE_KEY]: settings });
}
