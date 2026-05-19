/**
 * Extension settings — persisted in `storage.local`. Non-secret only;
 * a secret never lands here (SECURITY.md §3, invariant 3).
 */

export interface Settings {
    /** Auto-lock the vault after this many idle minutes. 0 = never. */
    idleLockMinutes: number;
    /** Offer to save / update a login when one is submitted. */
    captureEnabled: boolean;
    /** Show the inline autofill mark on recognised login fields. */
    showFieldIcon: boolean;
    /** Clear the clipboard this many seconds after a copy. 0 = never. */
    clipboardClearSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
    idleLockMinutes: 15,
    captureEnabled: true,
    showFieldIcon: true,
    clipboardClearSeconds: 30,
};

/** Selectable idle-lock durations, in minutes; 0 = never. */
export const IDLE_LOCK_CHOICES = [5, 15, 30, 60, 0] as const;

/** Selectable clipboard-clear delays, in seconds; 0 = never. */
export const CLIPBOARD_CLEAR_CHOICES = [15, 30, 60, 0] as const;

const STORE_KEY = 'oc-settings';

export async function loadSettings(): Promise<Settings> {
    const got = await browser.storage.local.get(STORE_KEY);
    const raw = (got[STORE_KEY] ?? {}) as Partial<Settings>;
    return {
        idleLockMinutes:
            typeof raw.idleLockMinutes === 'number'
                ? raw.idleLockMinutes
                : DEFAULT_SETTINGS.idleLockMinutes,
        captureEnabled:
            typeof raw.captureEnabled === 'boolean'
                ? raw.captureEnabled
                : DEFAULT_SETTINGS.captureEnabled,
        showFieldIcon:
            typeof raw.showFieldIcon === 'boolean'
                ? raw.showFieldIcon
                : DEFAULT_SETTINGS.showFieldIcon,
        clipboardClearSeconds:
            typeof raw.clipboardClearSeconds === 'number'
                ? raw.clipboardClearSeconds
                : DEFAULT_SETTINGS.clipboardClearSeconds,
    };
}

export async function saveSettings(settings: Settings): Promise<void> {
    await browser.storage.local.set({ [STORE_KEY]: settings });
}
