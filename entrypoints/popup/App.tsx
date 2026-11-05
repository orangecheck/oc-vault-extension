import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import { Mark } from '@orangecheck/app-design/brand';
import {
    Badge,
    Button,
    cn,
    DensityProvider,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Slider,
    Spinner,
    Switch,
} from '@orangecheck/app-design/primitives';

import type { VaultEntryFields, VaultEntrySummary, VaultEntryType } from '@/lib/crypto';
import { copyRequest } from '@/lib/copy';
import type { TotpNow } from '@/lib/totp';
import { send, type PendingCaptureInfo, type VaultState } from '@/lib/messaging';
import {
    generatePassphrase,
    generatePassword,
    passphraseEntropyBits,
    passwordAlphabet,
    passwordEntropyBits,
} from '@/lib/password-gen';
import { isPasskeySupported } from '@/lib/passkey';
import {
    CLIPBOARD_CLEAR_CHOICES,
    DEFAULT_SETTINGS,
    IDLE_LOCK_CHOICES,
    type Settings,
} from '@/lib/settings';
import { SIGNIN_URL, VAULT_DASHBOARD } from '@/lib/signin-url';

/** Field names whose value is masked until the user reveals it. */
const SECRET_FIELDS = new Set([
    'password',
    'secret',
    'key',
    'phrase',
    'cvv',
    'pin',
    'privateKey',
    // A login's TOTP seed.
    'totp',
]);

type View = 'list' | 'detail' | 'settings' | 'generate';

/** A compact `did:oc:…` for display. */
function shortDid(did: string): string {
    return did.length > 26 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did;
}

/** Copy to the clipboard, then clear it after `clearSeconds` (best-effort —
 *  the timer only fires while the popup is open). 0 = never clear. */
async function copyWithClear(value: string, clearSeconds: number): Promise<void> {
    await navigator.clipboard.writeText(value);
    if (clearSeconds > 0) {
        setTimeout(
            () => void navigator.clipboard.writeText('').catch(() => undefined),
            clearSeconds * 1000
        );
    }
}

/**
 * Open the passkey window (entrypoints/passkey). The ceremony cannot run in this
 * popup: it closes the moment an authenticator prompt takes focus.
 */
async function openPasskeyWindow(op: 'enroll' | 'unlock'): Promise<void> {
    await browser.windows.create({
        url: browser.runtime.getURL(`/passkey.html#${op}`),
        type: 'popup',
        width: 380,
        height: 340,
    });
    window.close();
}

/** Label for the auto-lock setting — 0 means it never auto-locks. */
function idleLabel(m: number): string {
    return m === 0 ? 'never' : `${m} min`;
}

/** Same choices, phrased for the unlock screen — 0 means it stays unlocked. */
function stayUnlockedLabel(m: number): string {
    return m === 0 ? 'forever' : `${m} min`;
}

export function App() {
    const [state, setState] = useState<VaultState | null>(null);
    const [entries, setEntries] = useState<VaultEntrySummary[]>([]);
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [pending, setPending] = useState<PendingCaptureInfo | null>(null);
    const [view, setView] = useState<View>('list');
    const [detailId, setDetailId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [typeFilter, setTypeFilter] = useState<VaultEntryType | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** A save that went through, but not as asked: an entry deleted elsewhere saved as new. */
    const [saveNotice, setSaveNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [confirmingLock, setConfirmingLock] = useState(false);
    /** This identity has a passkey set up to unlock the vault in this browser. */
    const [passkey, setPasskey] = useState(false);

    const loadPasskey = useCallback(async () => {
        try {
            setPasskey((await send({ kind: 'passkey-status' })).enrolled);
        } catch {
            setPasskey(false);
        }
    }, []);

    const loadEntries = useCallback(async () => {
        setEntries(await send({ kind: 'list-entries' }));
    }, []);

    /** Sync runs automatically — on open and after a capture. No button. */
    const refresh = useCallback(async () => {
        setSyncing(true);
        try {
            const s = await send({ kind: 'sync' });
            setState(s);
            await loadEntries();
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'sync failed');
        } finally {
            setSyncing(false);
        }
    }, [loadEntries]);

    const checkPending = useCallback(async () => {
        try {
            const { pending: p } = await send({ kind: 'get-pending-capture' });
            setPending(p);
        } catch {
            // best-effort
        }
    }, []);

    useEffect(() => {
        void (async () => {
            try {
                void send({ kind: 'get-settings' })
                    .then(setSettings)
                    .catch(() => undefined);
                const s = await send({ kind: 'get-state' });
                setState(s);
                if (s.status !== 'signed-out') void loadPasskey();
                if (s.status === 'unlocked') {
                    await loadEntries();
                    void checkPending();
                    void refresh();
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : 'could not reach the vault');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const updateSettings = useCallback(async (next: Settings) => {
        setSettings(next);
        try {
            await send({ kind: 'set-settings', settings: next });
        } catch {
            // best-effort
        }
    }, []);

    const types = useMemo(() => {
        const seen = new Set<VaultEntryType>();
        for (const e of entries) seen.add(e.type);
        return [...seen].sort();
    }, [entries]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return entries
            .filter(
                (e) =>
                    (!q || e.name.toLowerCase().includes(q)) &&
                    (!typeFilter || e.type === typeFilter)
            )
            .sort(
                (a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)
            );
    }, [entries, query, typeFilter]);

    if (!state) {
        return (
            <Shell>
                <p className={muted}>{error ?? 'Connecting to your vault…'}</p>
            </Shell>
        );
    }

    // The generator needs no vault, so it opens whatever the lock state.
    if (view === 'generate') {
        return (
            <Shell header={<BackButton onBack={() => setView('list')} />}>
                <GeneratorView clearSeconds={settings.clipboardClearSeconds} />
            </Shell>
        );
    }

    if (state.status === 'signed-out') {
        return (
            <Shell header={<GenerateLink onClick={() => setView('generate')} />}>
                <p className={muted}>Sign in with your orangecheck account to open your vault.</p>
                <Button asChild>
                    <a href={SIGNIN_URL} target="_blank" rel="noreferrer">
                        Sign in at ochk.io
                    </a>
                </Button>
            </Shell>
        );
    }

    if (state.status === 'locked') {
        return (
            <Shell header={<GenerateLink onClick={() => setView('generate')} />}>
                <UnlockGate
                    identity={state.identity}
                    passkey={passkey && isPasskeySupported()}
                    onPasskey={() => void openPasskeyWindow('unlock')}
                    busy={busy}
                    error={error}
                    settings={settings}
                    onIdleChange={(m) => void updateSettings({ ...settings, idleLockMinutes: m })}
                    onUnlock={async (passphrase) => {
                        setBusy(true);
                        setError(null);
                        try {
                            const s = await send({ kind: 'unlock', passphrase });
                            setState(s);
                            await loadEntries();
                            void checkPending();
                            void refresh();
                        } catch (err) {
                            setError(err instanceof Error ? err.message : 'could not unlock');
                        } finally {
                            setBusy(false);
                        }
                    }}
                />
            </Shell>
        );
    }

    const doLock = async () => {
        await send({ kind: 'lock' });
        setState({ status: 'locked', entryCount: 0, lastSyncAt: null, identity: state.identity });
        setEntries([]);
        setPending(null);
        setView('list');
        setDetailId(null);
        setConfirmingLock(false);
    };

    if (view === 'settings') {
        return (
            <Shell header={<BackButton onBack={() => setView('list')} />}>
                <SettingsView
                    settings={settings}
                    onChange={updateSettings}
                    passkey={passkey}
                    onPasskeySetUp={() => void openPasskeyWindow('enroll')}
                    onPasskeyRemove={async () => {
                        try {
                            await send({ kind: 'passkey-forget' });
                        } finally {
                            await loadPasskey();
                        }
                    }}
                />
                {error && <p className={errorText}>{error}</p>}
            </Shell>
        );
    }

    if (view === 'detail' && detailId) {
        const summary = entries.find((e) => e.id === detailId);
        return (
            <Shell header={<BackButton onBack={() => setView('list')} />}>
                {summary ? (
                    <EntryDetail
                        summary={summary}
                        clearSeconds={settings.clipboardClearSeconds}
                        onError={setError}
                    />
                ) : (
                    <p className={muted}>Entry not found.</p>
                )}
                {error && <p className={errorText}>{error}</p>}
            </Shell>
        );
    }

    return (
        <Shell
            header={
                confirmingLock ? (
                    <>
                        <Button variant="danger" size="sm" onClick={() => void doLock()}>
                            Lock now
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmingLock(false)}>
                            Cancel
                        </Button>
                    </>
                ) : (
                    <>
                        {syncing && (
                            <span role="status" className="px-1 text-muted-foreground">
                                <Spinner className="size-4" />
                                <span className="sr-only">Syncing</span>
                            </span>
                        )}
                        <GenerateLink onClick={() => setView('generate')} />
                        <HeaderButton onClick={() => setView('settings')}>Settings</HeaderButton>
                        <HeaderButton onClick={() => setConfirmingLock(true)}>Lock</HeaderButton>
                    </>
                )
            }
        >
            {saveNotice && (
                <div className={panel} role="status">
                    <p className="text-sm">{saveNotice}</p>
                    <div>
                        <Button size="sm" onClick={() => setSaveNotice(null)}>
                            OK
                        </Button>
                    </div>
                </div>
            )}
            {pending && (
                <div className={cn(panel, 'border-l-2 border-l-primary')}>
                    <p className="text-sm">
                        {pending.mode === 'update' ? 'Update' : 'Save'} the login for{' '}
                        <strong className="font-medium text-oca-accent-ink">{pending.host}</strong>
                        {pending.username ? ` · ${pending.username}` : ''}?
                    </p>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            onClick={async () => {
                                try {
                                    const { notice } = await send({ kind: 'commit-capture' });
                                    setPending(null);
                                    setSaveNotice(notice ?? null);
                                    void refresh();
                                } catch (err) {
                                    setError(err instanceof Error ? err.message : 'could not save');
                                }
                            }}
                        >
                            {pending.mode === 'update' ? 'Update' : 'Save'}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={async () => {
                                await send({ kind: 'dismiss-capture' }).catch(() => undefined);
                                setPending(null);
                            }}
                        >
                            Dismiss
                        </Button>
                    </div>
                </div>
            )}
            {!settings.browserPmNoticeDismissed && (
                <BrowserPmNotice
                    onDismiss={() =>
                        void updateSettings({ ...settings, browserPmNoticeDismissed: true })
                    }
                />
            )}
            <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${state.entryCount} entries`}
                aria-label="Search entries"
                autoFocus
            />
            {types.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                    <Chip label="all" active={!typeFilter} onClick={() => setTypeFilter(null)} />
                    {types.map((t) => (
                        <Chip
                            key={t}
                            label={t}
                            active={typeFilter === t}
                            onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                        />
                    ))}
                </div>
            )}
            {error && entries.length > 0 && <p className={errorText}>{error}</p>}
            <ul className="-mx-1 flex max-h-[360px] flex-col overflow-y-auto">
                {filtered.map((entry) => (
                    <li key={entry.id} className="flex items-center gap-2 border-b border-border">
                        <button
                            type="button"
                            className="flex min-w-0 flex-1 flex-col gap-1 px-1 py-2.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => {
                                setDetailId(entry.id);
                                setView('detail');
                                setError(null);
                            }}
                        >
                            <span className="truncate text-sm font-medium">
                                {entry.favorite ? '★ ' : ''}
                                {entry.name}
                            </span>
                            <span className={cn(label, 'flex items-center gap-1.5')}>
                                {entry.type}
                                {entry.folder ? (
                                    <span className="max-w-[120px] truncate border border-border px-1.5 normal-case tracking-normal">
                                        {entry.folder}
                                    </span>
                                ) : null}
                            </span>
                        </button>
                        <Button
                            variant="secondary"
                            size="sm"
                            className="mr-1 px-3"
                            title={
                                entry.type === 'totp'
                                    ? 'copy the current code'
                                    : 'copy the primary value'
                            }
                            aria-label={`Copy ${entry.name}`}
                            onClick={async () => {
                                try {
                                    // A TOTP entry copies its current code, never its secret.
                                    const ask = copyRequest(entry.type);
                                    const value =
                                        ask.kind === 'totp-code'
                                            ? (await send({ kind: 'totp-code', entryId: entry.id }))
                                                  .code
                                            : (
                                                  await send({
                                                      kind: 'reveal-field',
                                                      entryId: entry.id,
                                                      field: ask.field,
                                                  })
                                              ).value;
                                    await copyWithClear(value, settings.clipboardClearSeconds);
                                    setError(null);
                                } catch {
                                    setError('could not copy that entry');
                                }
                            }}
                        >
                            Copy
                        </Button>
                    </li>
                ))}
                {filtered.length === 0 && entries.length > 0 && (
                    <li className={cn(muted, 'px-1 py-2.5')}>No entries match your search.</li>
                )}
            </ul>
            {entries.length === 0 && !syncing && (
                <div className="flex flex-col gap-2">
                    {state.identity && (
                        <p className={muted}>
                            Signed in as{' '}
                            <strong className="font-mono font-normal text-foreground">
                                {shortDid(state.identity)}
                            </strong>
                        </p>
                    )}
                    {error && <p className={errorText}>vault.ochk.io: {error}</p>}
                    <p className={muted}>
                        This account has no entries the extension can load. Autofill reads your{' '}
                        <strong className="font-medium text-foreground">cloud-synced</strong> vault
                        — if your secrets are under a different orangecheck account, sign in as that
                        one; if cloud sync isn&apos;t on for this account, enable it at
                        vault.ochk.io.
                    </p>
                    <Button asChild>
                        <a href={SIGNIN_URL} target="_blank" rel="noreferrer">
                            Switch identity at ochk.io
                        </a>
                    </Button>
                </div>
            )}
            {entries.length > 0 && state.identity && (
                <p className={cn(label, 'break-all normal-case tracking-normal')}>
                    Signed in · {shortDid(state.identity)}
                </p>
            )}
        </Shell>
    );
}

/** This browser's settings URL — Edge uses its own scheme. */
function browserSettingsUrl(): string {
    return /\bEdg\//.test(navigator.userAgent) ? 'edge://settings/' : 'chrome://settings/';
}

/**
 * One-time notice: a browser's built-in password manager pops its own
 * autofill menu, colliding with OC Vault's. No extension API can suppress
 * the native menu — so, as 1Password and Bitwarden do, we guide the user
 * to turn it off. (Or they can flip off the focus menu in settings.)
 */
function BrowserPmNotice({ onDismiss }: { onDismiss: () => void }) {
    return (
        <div className={panel}>
            <p className={muted}>
                <strong className="font-medium text-foreground">Seeing two autofill menus?</strong>{' '}
                Your browser has its own password manager. Turn it off — in Settings → Autofill /
                Passwords, switch off “offer to save passwords” — so only OC Vault offers to fill.
            </p>
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    onClick={() => void browser.tabs.create({ url: browserSettingsUrl() })}
                >
                    Open browser settings
                </Button>
                <Button variant="ghost" size="sm" onClick={onDismiss}>
                    Got it
                </Button>
            </div>
        </div>
    );
}

/** Muted body copy, the error line, a mono label, and a bordered panel: the popup's four voices. */
const muted = 'text-[0.8125rem] leading-relaxed text-muted-foreground';
const errorText = 'text-[0.8125rem] text-destructive';
const label = 'oca-label text-[0.6875rem]';
const panel = 'flex flex-col gap-2.5 border border-border bg-card p-3';

function Shell({ header, children }: { header?: ReactNode; children: ReactNode }) {
    return (
        <DensityProvider density="compact">
            <div className="flex min-h-[200px] w-[360px] flex-col bg-background text-foreground">
                <div className="flex h-12 items-center justify-between gap-2 border-b border-border pl-4 pr-2">
                    <a
                        className="inline-flex items-center gap-2 text-[0.9375rem] font-medium tracking-[-0.01em] text-foreground"
                        href={VAULT_DASHBOARD}
                        target="_blank"
                        rel="noreferrer"
                        title="open vault.ochk.io"
                    >
                        <Mark size={20} />
                        <span>
                            <span className="sr-only">OC </span>vault
                        </span>
                    </a>
                    <div className="flex items-center gap-0.5">{header}</div>
                </div>
                <div className="flex flex-col gap-3 p-4">{children}</div>
            </div>
        </DensityProvider>
    );
}

/** A header action: quiet, with the text a person reads. */
function HeaderButton({
    onClick,
    title,
    children,
}: {
    onClick: () => void;
    title?: string;
    children: ReactNode;
}) {
    return (
        <Button variant="ghost" size="sm" className="px-2.5" title={title} onClick={onClick}>
            {children}
        </Button>
    );
}

function BackButton({ onBack }: { onBack: () => void }) {
    return <HeaderButton onClick={onBack}>← Back</HeaderButton>;
}

function GenerateLink({ onClick }: { onClick: () => void }) {
    return (
        <HeaderButton onClick={onClick} title="make a strong password">
            Generate
        </HeaderButton>
    );
}

type GenMode = 'password' | 'passphrase';

interface GenOptions {
    mode: GenMode;
    length: number;
    lowercase: boolean;
    uppercase: boolean;
    digits: boolean;
    symbols: boolean;
    excludeAmbiguous: boolean;
    words: number;
    separator: string;
    capitalize: boolean;
    includeNumber: boolean;
}

/** vault.ochk.io's generator starts at the same place: 20 characters, every class, or 6 words. */
const GEN_DEFAULTS: GenOptions = {
    mode: 'password',
    length: 20,
    lowercase: true,
    uppercase: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
    words: 6,
    separator: '-',
    capitalize: false,
    includeNumber: false,
};

const SEPARATORS: { value: string; label: string }[] = [
    { value: '-', label: 'dash' },
    { value: ' ', label: 'space' },
    { value: '.', label: 'dot' },
    { value: '_', label: 'underscore' },
];

/** A new value for the options, or '' when no character class is on. */
function generateFor(o: GenOptions): string {
    if (o.mode === 'passphrase') return generatePassphrase(o);
    return passwordAlphabet(o).length === 0 ? '' : generatePassword(o);
}

/**
 * The password generator. A value is made in this popup from the browser's
 * secure random source and goes nowhere but the clipboard, on a copy.
 */
function GeneratorView({ clearSeconds }: { clearSeconds: number }) {
    const [opts, setOpts] = useState<GenOptions>(GEN_DEFAULTS);
    const [value, setValue] = useState(() => generateFor(GEN_DEFAULTS));
    const [copied, setCopied] = useState(false);
    const update = (next: GenOptions) => {
        setOpts(next);
        setValue(generateFor(next));
        setCopied(false);
    };
    const bits = Math.floor(
        opts.mode === 'password' ? passwordEntropyBits(opts) : passphraseEntropyBits(opts)
    );
    const flag = (
        key: 'lowercase' | 'uppercase' | 'digits' | 'symbols' | 'excludeAmbiguous',
        text: string
    ) => (
        <SettingSwitch
            label={text}
            checked={opts[key]}
            onChange={() => update({ ...opts, [key]: !opts[key] })}
        />
    );
    return (
        <div className="flex flex-col gap-3">
            <div className="flex gap-1.5">
                <Chip
                    label="password"
                    active={opts.mode === 'password'}
                    onClick={() => update({ ...opts, mode: 'password' })}
                />
                <Chip
                    label="passphrase"
                    active={opts.mode === 'passphrase'}
                    onClick={() => update({ ...opts, mode: 'passphrase' })}
                />
            </div>
            <output
                className="block select-all break-all border border-border bg-card px-3 py-2.5 font-mono text-[0.9375rem] leading-snug"
                aria-live="polite"
            >
                {value || '—'}
            </output>
            {value ? (
                <p className={cn(muted, '-mt-1.5')}>
                    about {bits} bits ·{' '}
                    {opts.mode === 'password'
                        ? `${value.length} characters`
                        : `${opts.words} words`}
                </p>
            ) : (
                <p className={errorText}>Turn on at least one kind of character.</p>
            )}
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    disabled={!value}
                    onClick={async () => {
                        await copyWithClear(value, clearSeconds);
                        setCopied(true);
                    }}
                >
                    {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button variant="ghost" size="sm" disabled={!value} onClick={() => update(opts)}>
                    New
                </Button>
            </div>
            {opts.mode === 'password' ? (
                <div className="flex flex-col gap-3">
                    <SettingSlider
                        label={`length ${opts.length}`}
                        name="length"
                        min={8}
                        max={64}
                        value={opts.length}
                        valueText={(v) => `${v} characters`}
                        onChange={(length) => update({ ...opts, length })}
                    />
                    {flag('lowercase', 'a–z')}
                    {flag('uppercase', 'A–Z')}
                    {flag('digits', '0–9')}
                    {flag('symbols', 'symbols')}
                    {flag('excludeAmbiguous', 'leave out look-alikes (0 O o 1 l I)')}
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    <SettingSlider
                        label={`words ${opts.words}`}
                        name="words"
                        min={3}
                        max={10}
                        value={opts.words}
                        valueText={(v) => `${v} words`}
                        onChange={(words) => update({ ...opts, words })}
                    />
                    <SettingSelect
                        label="between words"
                        value={opts.separator}
                        options={SEPARATORS}
                        onChange={(separator) => update({ ...opts, separator })}
                    />
                    <SettingSwitch
                        label="capitalize"
                        checked={opts.capitalize}
                        onChange={() => update({ ...opts, capitalize: !opts.capitalize })}
                    />
                    <SettingSwitch
                        label="add a number"
                        checked={opts.includeNumber}
                        onChange={() => update({ ...opts, includeNumber: !opts.includeNumber })}
                    />
                </div>
            )}
            <p className={muted}>
                Made in this browser from its secure random source. Nothing is saved or sent;
                {clearSeconds > 0
                    ? ` a copy clears from the clipboard after ${clearSeconds}s while this popup stays open.`
                    : ' a copy stays on the clipboard (clearing is off in settings).'}
            </p>
        </div>
    );
}

/** A filter or a mode: a mono label, pressed or not. */
function Chip({
    label: text,
    active,
    onClick,
}: {
    label: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={cn(
                'inline-flex h-7 items-center border px-2.5 font-mono text-[0.6875rem] uppercase tracking-[0.08em] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                active
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground'
            )}
        >
            {text}
        </button>
    );
}

/** One setting: its words on the left, its control on the right. */
function SettingRow({
    id,
    label: text,
    children,
}: {
    id: string;
    label: string;
    children: ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <Label htmlFor={id} className="font-normal leading-snug">
                {text}
            </Label>
            {children}
        </div>
    );
}

function SettingSwitch({
    label: text,
    checked,
    onChange,
}: {
    label: string;
    checked: boolean;
    onChange: () => void;
}) {
    const id = useId();
    return (
        <SettingRow id={id} label={text}>
            <Switch id={id} checked={checked} onCheckedChange={onChange} />
        </SettingRow>
    );
}

function SettingSelect<T extends string | number>({
    label: text,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: { value: T; label: string }[];
    onChange: (value: T) => void;
}) {
    const id = useId();
    return (
        <SettingRow id={id} label={text}>
            <Select
                value={String(value)}
                onValueChange={(v) => {
                    const picked = options.find((o) => String(o.value) === v);
                    if (picked) onChange(picked.value);
                }}
            >
                <SelectTrigger id={id} className="w-[132px] shrink-0">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((o) => (
                        <SelectItem key={o.label} value={String(o.value)}>
                            {o.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </SettingRow>
    );
}

function SettingSlider({
    label: text,
    name,
    min,
    max,
    value,
    valueText,
    onChange,
}: {
    label: string;
    name: string;
    min: number;
    max: number;
    value: number;
    valueText: (value: number) => string;
    onChange: (value: number) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-sm">{text}</span>
            <Slider
                className="w-[150px]"
                min={min}
                max={max}
                value={value}
                aria-label={name}
                valueText={valueText}
                onValueChange={onChange}
            />
        </div>
    );
}

function EntryDetail({
    summary,
    clearSeconds,
    onError,
}: {
    summary: VaultEntrySummary;
    clearSeconds: number;
    onError: (message: string | null) => void;
}) {
    const [fields, setFields] = useState<VaultEntryFields | null>(null);
    /** Fields the worker left out (a TOTP secret); each is fetched only on show or copy. */
    const [held, setHeld] = useState<string[]>([]);
    /** Held fields the person asked to see, by name. */
    const [fetched, setFetched] = useState<Record<string, string>>({});
    const [shown, setShown] = useState<Set<string>>(new Set());

    useEffect(() => {
        void (async () => {
            try {
                const r = await send({ kind: 'reveal-entry', entryId: summary.id });
                setFields(r.fields);
                setHeld(r.held);
            } catch (err) {
                onError(err instanceof Error ? err.message : 'could not open that entry');
            }
        })();
    }, [summary.id, onError]);

    /** A held field's value, asked of the worker by name, once. */
    const fetchHeld = async (name: string): Promise<string> => {
        if (fetched[name] !== undefined) return fetched[name];
        const { value } = await send({ kind: 'reveal-field', entryId: summary.id, field: name });
        setFetched((f) => ({ ...f, [name]: value }));
        return value;
    };

    const rows = useMemo(() => {
        if (!fields) return [];
        const plain = Object.entries(fields).filter(
            ([, v]) => typeof v === 'string' && v.length > 0
        ) as [string, string][];
        return [...plain, ...held.map((name) => [name, fetched[name] ?? null] as [string, null])];
    }, [fields, held, fetched]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1 border-b border-border pb-3">
                <h1 className="oca-title-sm break-words">{summary.name}</h1>
                <span className={label}>{summary.type}</span>
            </div>
            {!fields && <p className={muted}>Decrypting…</p>}
            {fields && (summary.type === 'totp' || held.includes('totp')) && (
                <TotpCodeView entryId={summary.id} clearSeconds={clearSeconds} onError={onError} />
            )}
            <ul className="flex flex-col">
                {rows.map(([name, value]) => {
                    const secret = SECRET_FIELDS.has(name) || held.includes(name);
                    const reveal = !secret || shown.has(name);
                    return (
                        <li
                            key={name}
                            className="flex items-center gap-2 border-b border-border py-2"
                        >
                            <span className={cn(label, 'w-[72px] shrink-0 break-words')}>
                                {name}
                            </span>
                            <span className="min-w-0 flex-1 break-all font-mono text-[0.8125rem]">
                                {reveal && value !== null
                                    ? value
                                    : '•'.repeat(Math.min(value?.length ?? 12, 12))}
                            </span>
                            <div className="flex shrink-0 gap-1">
                                {secret && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="px-2.5"
                                        aria-label={`${reveal ? 'Hide' : 'Show'} ${name}`}
                                        onClick={async () => {
                                            if (!reveal && value === null) await fetchHeld(name);
                                            setShown((s) => {
                                                const next = new Set(s);
                                                if (next.has(name)) next.delete(name);
                                                else next.add(name);
                                                return next;
                                            });
                                        }}
                                    >
                                        {reveal ? 'Hide' : 'Show'}
                                    </Button>
                                )}
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    className="px-2.5"
                                    aria-label={`Copy ${name}`}
                                    onClick={async () => {
                                        const v = value ?? (await fetchHeld(name));
                                        await copyWithClear(v, clearSeconds);
                                        onError(null);
                                    }}
                                >
                                    Copy
                                </Button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** "123456" → "123 456": a code read off the screen in two halves. */
function groupCode(code: string): string {
    const half = Math.floor(code.length / 2);
    return `${code.slice(0, half)} ${code.slice(half)}`;
}

/**
 * The entry's live TOTP code and the seconds it has left. The worker makes each
 * code from the secret it holds; the popup asks again when the period turns.
 * A code is copied only on a click, and nothing here is stored.
 */
function TotpCodeView({
    entryId,
    clearSeconds,
    onError,
}: {
    entryId: string;
    clearSeconds: number;
    onError: (message: string | null) => void;
}) {
    const [now, setNow] = useState<TotpNow | null>(null);
    const [left, setLeft] = useState(0);
    const [copied, setCopied] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        let next: ReturnType<typeof setTimeout> | undefined;
        const load = async () => {
            try {
                const r = await send({ kind: 'totp-code', entryId });
                if (!alive) return;
                setNow(r);
                setLeft(r.remaining);
                setCopied(false);
                next = setTimeout(() => void load(), r.remaining * 1000 + 50);
            } catch (err) {
                if (alive) setFailed(err instanceof Error ? err.message : 'no code');
            }
        };
        void load();
        const tick = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
        return () => {
            alive = false;
            if (next) clearTimeout(next);
            clearInterval(tick);
        };
    }, [entryId]);

    if (failed) return <p className={errorText}>{failed}</p>;
    return (
        <div className="flex items-center gap-3 border border-border bg-card px-3 py-2.5">
            <span className={label}>code</span>
            <output
                className="flex-1 font-mono text-[1.375rem] tracking-[0.08em] oca-tabular"
                aria-live="polite"
            >
                {now ? groupCode(now.code) : '··· ···'}
            </output>
            <span
                className="oca-numeral min-w-[28px] text-right"
                title="seconds until the next code"
            >
                {now ? `${left}s` : ''}
            </span>
            <Button
                variant="secondary"
                size="sm"
                className="px-2.5"
                disabled={!now}
                onClick={async () => {
                    if (!now) return;
                    await copyWithClear(now.code, clearSeconds);
                    setCopied(true);
                    onError(null);
                }}
            >
                {copied ? 'Copied' : 'Copy'}
            </Button>
        </div>
    );
}

function SettingsView({
    settings,
    onChange,
    passkey,
    onPasskeySetUp,
    onPasskeyRemove,
}: {
    settings: Settings;
    onChange: (next: Settings) => void;
    passkey: boolean;
    onPasskeySetUp: () => void;
    onPasskeyRemove: () => void;
}) {
    const [confirmingRemove, setConfirmingRemove] = useState(false);
    return (
        <div className="flex flex-col gap-3.5">
            {isPasskeySupported() && (
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm">Unlock with a passkey</span>
                    {passkey ? (
                        confirmingRemove ? (
                            <span className="flex items-center gap-1">
                                <Button
                                    variant="danger"
                                    size="sm"
                                    className="px-3"
                                    onClick={() => {
                                        setConfirmingRemove(false);
                                        onPasskeyRemove();
                                    }}
                                >
                                    Remove
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="px-3"
                                    onClick={() => setConfirmingRemove(false)}
                                >
                                    Cancel
                                </Button>
                            </span>
                        ) : (
                            <span className="flex items-center gap-2">
                                <Badge tone="brand">on</Badge>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="px-3"
                                    onClick={() => setConfirmingRemove(true)}
                                >
                                    Remove
                                </Button>
                            </span>
                        )
                    ) : (
                        <Button
                            variant="secondary"
                            size="sm"
                            className="px-3"
                            onClick={onPasskeySetUp}
                        >
                            Set up
                        </Button>
                    )}
                </div>
            )}
            <SettingSelect
                label="Auto-lock when idle"
                value={settings.idleLockMinutes}
                options={IDLE_LOCK_CHOICES.map((m) => ({ value: m, label: idleLabel(m) }))}
                onChange={(idleLockMinutes) => onChange({ ...settings, idleLockMinutes })}
            />
            <SettingSwitch
                label="Offer to save new logins"
                checked={settings.captureEnabled}
                onChange={() => onChange({ ...settings, captureEnabled: !settings.captureEnabled })}
            />
            <SettingSwitch
                label="Offer autofill on login fields"
                checked={settings.showFieldIcon}
                onChange={() => onChange({ ...settings, showFieldIcon: !settings.showFieldIcon })}
            />
            <SettingSwitch
                label="Open the autofill menu on field focus"
                checked={settings.autofillMenuOnFocus}
                onChange={() =>
                    onChange({ ...settings, autofillMenuOnFocus: !settings.autofillMenuOnFocus })
                }
            />
            <SettingSelect
                label="Clear the clipboard after copy"
                value={settings.clipboardClearSeconds}
                options={CLIPBOARD_CLEAR_CHOICES.map((s) => ({
                    value: s,
                    label: s === 0 ? 'never' : `${s}s`,
                }))}
                onChange={(clipboardClearSeconds) =>
                    onChange({ ...settings, clipboardClearSeconds })
                }
            />
            <p className={muted}>
                Turn the focus menu off if you keep your browser&apos;s built-in password manager —
                OC Vault&apos;s menu then opens only when you click its mark, so the two never both
                pop up.
            </p>
            <p className={muted}>
                The vault locks on the idle timer, when you lock it, and when the browser closes.
                Its key is held in memory, never written to disk
                {passkey ? ' — except sealed to your passkey, which only that passkey opens.' : '.'}
            </p>
        </div>
    );
}

function UnlockGate({
    identity,
    passkey,
    onPasskey,
    busy,
    error,
    settings,
    onIdleChange,
    onUnlock,
}: {
    identity: string | null;
    passkey: boolean;
    onPasskey: () => void;
    busy: boolean;
    error: string | null;
    settings: Settings;
    onIdleChange: (minutes: number) => void;
    onUnlock: (passphrase: string) => void;
}) {
    const [passphrase, setPassphrase] = useState('');
    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
                e.preventDefault();
                if (passphrase) onUnlock(passphrase);
            }}
        >
            <p className={muted}>
                Enter your vault passphrase. Being signed in lets the extension fetch your encrypted
                vault; the passphrase decrypts it — orangecheck never can.
            </p>
            {identity && (
                <p className={cn(label, 'break-all normal-case tracking-normal')}>
                    Unlocking · {shortDid(identity)}
                </p>
            )}
            {passkey && (
                <Button type="button" onClick={onPasskey}>
                    Unlock with passkey
                </Button>
            )}
            <Input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Vault passphrase"
                aria-label="Vault passphrase"
                autoComplete="current-password"
                autoFocus
            />
            {error && <p className={errorText}>{error}</p>}
            <Button
                type="submit"
                variant={passkey ? 'secondary' : 'primary'}
                loading={busy}
                disabled={busy || !passphrase}
            >
                {busy ? 'Unlocking…' : 'Unlock'}
            </Button>
            <SettingSelect
                label="Stay unlocked for"
                value={settings.idleLockMinutes}
                options={IDLE_LOCK_CHOICES.map((m) => ({ value: m, label: stayUnlockedLabel(m) }))}
                onChange={onIdleChange}
            />
        </form>
    );
}
