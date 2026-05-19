import { useCallback, useEffect, useMemo, useState } from 'react';

import type { VaultEntryFields, VaultEntrySummary, VaultEntryType } from '@/lib/crypto';
import { send, type PendingCaptureInfo, type VaultState } from '@/lib/messaging';
import {
    CLIPBOARD_CLEAR_CHOICES,
    DEFAULT_SETTINGS,
    IDLE_LOCK_CHOICES,
    type Settings,
} from '@/lib/settings';

/** The decrypted field to copy for each entry type — the "primary" secret. */
const PRIMARY_FIELD: Record<VaultEntryType, string> = {
    password: 'password',
    note: 'body',
    'seed-phrase': 'phrase',
    totp: 'secret',
    'api-key': 'key',
    kv: 'value',
    card: 'number',
    identity: 'email',
    file: 'filename',
};

/** Field names whose value is masked until the user reveals it. */
const SECRET_FIELDS = new Set(['password', 'secret', 'key', 'phrase', 'cvv', 'pin', 'privateKey']);

const SIGNIN_URL = 'https://ochk.io/signin?return_to=%2Fvault';

type View = 'list' | 'detail' | 'settings';

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

function idleLabel(m: number): string {
    return m === 0 ? 'never' : `${m} min`;
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
    const [busy, setBusy] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [confirmingLock, setConfirmingLock] = useState(false);

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
                <p className="muted">{error ?? 'connecting to your vault…'}</p>
            </Shell>
        );
    }

    if (state.status === 'signed-out') {
        return (
            <Shell>
                <p className="muted">Sign in with your OrangeCheck identity to open your vault.</p>
                <a className="btn" href={SIGNIN_URL} target="_blank" rel="noreferrer">
                    sign in at ochk.io
                </a>
            </Shell>
        );
    }

    if (state.status === 'locked') {
        return (
            <Shell>
                <UnlockGate
                    identity={state.identity}
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
                <SettingsView settings={settings} onChange={updateSettings} />
                {error && <p className="error">{error}</p>}
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
                    <p className="muted">entry not found</p>
                )}
                {error && <p className="error">{error}</p>}
            </Shell>
        );
    }

    return (
        <Shell
            header={
                <div className="topbar-actions">
                    {syncing && <span className="syncing">syncing…</span>}
                    <button className="link" onClick={() => setView('settings')}>
                        settings
                    </button>
                    {confirmingLock ? (
                        <>
                            <button className="link danger" onClick={() => void doLock()}>
                                lock?
                            </button>
                            <button className="link" onClick={() => setConfirmingLock(false)}>
                                cancel
                            </button>
                        </>
                    ) : (
                        <button className="link" onClick={() => setConfirmingLock(true)}>
                            lock
                        </button>
                    )}
                </div>
            }
        >
            {pending && (
                <div className="capture-banner">
                    <p>
                        {pending.mode === 'update' ? 'Update' : 'Save'} the login for{' '}
                        <strong>{pending.host}</strong>
                        {pending.username ? ` · ${pending.username}` : ''}?
                    </p>
                    <div className="capture-actions">
                        <button
                            className="btn"
                            onClick={async () => {
                                try {
                                    await send({ kind: 'commit-capture' });
                                    setPending(null);
                                    void refresh();
                                } catch (err) {
                                    setError(err instanceof Error ? err.message : 'could not save');
                                }
                            }}
                        >
                            {pending.mode === 'update' ? 'update' : 'save'}
                        </button>
                        <button
                            className="link"
                            onClick={async () => {
                                await send({ kind: 'dismiss-capture' }).catch(() => undefined);
                                setPending(null);
                            }}
                        >
                            dismiss
                        </button>
                    </div>
                </div>
            )}
            <input
                className="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`search ${state.entryCount} entries`}
                autoFocus
            />
            {types.length > 1 && (
                <div className="chips">
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
            {error && entries.length > 0 && <p className="error">{error}</p>}
            <ul className="entries">
                {filtered.map((entry) => (
                    <li
                        key={entry.id}
                        className="entry entry-clickable"
                        onClick={() => {
                            setDetailId(entry.id);
                            setView('detail');
                            setError(null);
                        }}
                    >
                        <div className="entry-main">
                            <span className="entry-name">
                                {entry.favorite ? '★ ' : ''}
                                {entry.name}
                            </span>
                            <span className="entry-type">{entry.type}</span>
                        </div>
                        <button
                            className="copy"
                            title="copy the primary value"
                            onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                    const { value } = await send({
                                        kind: 'reveal-field',
                                        entryId: entry.id,
                                        field: PRIMARY_FIELD[entry.type],
                                    });
                                    await copyWithClear(value, settings.clipboardClearSeconds);
                                    setError(null);
                                } catch {
                                    setError('could not copy that entry');
                                }
                            }}
                        >
                            copy
                        </button>
                    </li>
                ))}
                {filtered.length === 0 && entries.length > 0 && (
                    <li className="muted">no entries match your search</li>
                )}
            </ul>
            {entries.length === 0 && !syncing && (
                <div className="empty">
                    {state.identity && (
                        <p className="muted">
                            signed in as <strong>{shortDid(state.identity)}</strong>
                        </p>
                    )}
                    {error && <p className="error">vault.ochk.io: {error}</p>}
                    <p className="muted">
                        This identity has no entries the extension can load. Autofill reads your{' '}
                        <strong>cloud-synced</strong> vault — if your secrets are under a different
                        OrangeCheck identity, sign in as that one; if cloud sync isn&apos;t on for
                        this identity, enable it at vault.ochk.io.
                    </p>
                    <a className="btn" href={SIGNIN_URL} target="_blank" rel="noreferrer">
                        switch identity at ochk.io
                    </a>
                </div>
            )}
            {entries.length > 0 && state.identity && (
                <p className="who-line">signed in · {shortDid(state.identity)}</p>
            )}
        </Shell>
    );
}

function Shell({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="popup">
            <div className="topbar">
                <span className="brand">
                    oc <strong>vault</strong>
                </span>
                {header}
            </div>
            <div className="body">{children}</div>
        </div>
    );
}

function BackButton({ onBack }: { onBack: () => void }) {
    return (
        <button className="link" onClick={onBack}>
            ← back
        </button>
    );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button className={active ? 'chip chip-active' : 'chip'} onClick={onClick}>
            {label}
        </button>
    );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            className={on ? 'toggle toggle-on' : 'toggle'}
            onClick={onClick}
        >
            {on ? 'on' : 'off'}
        </button>
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
    const [shown, setShown] = useState<Set<string>>(new Set());

    useEffect(() => {
        void (async () => {
            try {
                const { fields: f } = await send({ kind: 'reveal-entry', entryId: summary.id });
                setFields(f);
            } catch (err) {
                onError(err instanceof Error ? err.message : 'could not open that entry');
            }
        })();
    }, [summary.id, onError]);

    const rows = useMemo(() => {
        if (!fields) return [];
        return Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.length > 0) as [
            string,
            string,
        ][];
    }, [fields]);

    return (
        <div>
            <div className="detail-head">
                <span className="entry-name">{summary.name}</span>
                <span className="entry-type">{summary.type}</span>
            </div>
            {!fields && <p className="muted">decrypting…</p>}
            <ul className="fields">
                {rows.map(([name, value]) => {
                    const secret = SECRET_FIELDS.has(name);
                    const reveal = !secret || shown.has(name);
                    return (
                        <li key={name} className="field">
                            <span className="field-name">{name}</span>
                            <span className="field-value">
                                {reveal ? value : '•'.repeat(Math.min(value.length, 12))}
                            </span>
                            <div className="field-actions">
                                {secret && (
                                    <button
                                        className="copy"
                                        onClick={() =>
                                            setShown((s) => {
                                                const next = new Set(s);
                                                if (next.has(name)) next.delete(name);
                                                else next.add(name);
                                                return next;
                                            })
                                        }
                                    >
                                        {reveal ? 'hide' : 'show'}
                                    </button>
                                )}
                                <button
                                    className="copy"
                                    onClick={async () => {
                                        await copyWithClear(value, clearSeconds);
                                        onError(null);
                                    }}
                                >
                                    copy
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function SettingsView({
    settings,
    onChange,
}: {
    settings: Settings;
    onChange: (next: Settings) => void;
}) {
    return (
        <div className="settings">
            <div className="setting">
                <span>auto-lock when idle</span>
                <select
                    value={settings.idleLockMinutes}
                    onChange={(e) =>
                        onChange({ ...settings, idleLockMinutes: Number(e.target.value) })
                    }
                >
                    {IDLE_LOCK_CHOICES.map((m) => (
                        <option key={m} value={m}>
                            {idleLabel(m)}
                        </option>
                    ))}
                </select>
            </div>
            <div className="setting">
                <span>offer to save new logins</span>
                <Toggle
                    on={settings.captureEnabled}
                    onClick={() =>
                        onChange({ ...settings, captureEnabled: !settings.captureEnabled })
                    }
                />
            </div>
            <div className="setting">
                <span>show the autofill icon on fields</span>
                <Toggle
                    on={settings.showFieldIcon}
                    onClick={() =>
                        onChange({ ...settings, showFieldIcon: !settings.showFieldIcon })
                    }
                />
            </div>
            <div className="setting">
                <span>clear the clipboard after copy</span>
                <select
                    value={settings.clipboardClearSeconds}
                    onChange={(e) =>
                        onChange({ ...settings, clipboardClearSeconds: Number(e.target.value) })
                    }
                >
                    {CLIPBOARD_CLEAR_CHOICES.map((s) => (
                        <option key={s} value={s}>
                            {s === 0 ? 'never' : `${s}s`}
                        </option>
                    ))}
                </select>
            </div>
            <p className="muted">
                The vault locks whenever the browser suspends the extension; your key is held only
                in memory, never written to disk.
            </p>
        </div>
    );
}

function UnlockGate({
    identity,
    busy,
    error,
    settings,
    onIdleChange,
    onUnlock,
}: {
    identity: string | null;
    busy: boolean;
    error: string | null;
    settings: Settings;
    onIdleChange: (minutes: number) => void;
    onUnlock: (passphrase: string) => void;
}) {
    const [passphrase, setPassphrase] = useState('');
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                if (passphrase) onUnlock(passphrase);
            }}
        >
            <p className="muted">
                Enter your vault passphrase. Being signed in lets the extension fetch your encrypted
                vault; the passphrase decrypts it — OrangeCheck never can.
            </p>
            {identity && <p className="who-line">unlocking · {shortDid(identity)}</p>}
            <input
                className="search"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="vault passphrase"
                autoComplete="current-password"
                autoFocus
            />
            {error && <p className="error">{error}</p>}
            <button className="btn" type="submit" disabled={busy || !passphrase}>
                {busy ? 'unlocking…' : 'unlock'}
            </button>
            <div className="setting setting-inline">
                <span>stay unlocked for</span>
                <select
                    value={settings.idleLockMinutes}
                    onChange={(e) => onIdleChange(Number(e.target.value))}
                >
                    {IDLE_LOCK_CHOICES.map((m) => (
                        <option key={m} value={m}>
                            {idleLabel(m)}
                        </option>
                    ))}
                </select>
            </div>
        </form>
    );
}
