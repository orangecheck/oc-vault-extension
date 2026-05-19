import { useCallback, useEffect, useMemo, useState } from 'react';

import type { VaultEntryFields, VaultEntrySummary, VaultEntryType } from '@/lib/crypto';
import { send, type VaultState } from '@/lib/messaging';
import { DEFAULT_SETTINGS, IDLE_LOCK_CHOICES, type Settings } from '@/lib/settings';

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

export function App() {
    const [state, setState] = useState<VaultState | null>(null);
    const [entries, setEntries] = useState<VaultEntrySummary[]>([]);
    const [view, setView] = useState<View>('list');
    const [detailId, setDetailId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [typeFilter, setTypeFilter] = useState<VaultEntryType | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const loadEntries = useCallback(async () => {
        setEntries(await send({ kind: 'list-entries' }));
    }, []);

    useEffect(() => {
        void (async () => {
            try {
                const s = await send({ kind: 'get-state' });
                setState(s);
                if (s.status === 'unlocked') {
                    await loadEntries();
                    // Refresh from the server — surfaces a sync error (e.g.
                    // cloud sync not enabled) the cached state would hide.
                    void refresh();
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : 'could not reach the vault');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** Unlock paints from the ciphertext cache; this refreshes from the server. */
    const refresh = useCallback(async () => {
        try {
            const s = await send({ kind: 'sync' });
            setState(s);
            await loadEntries();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'sync failed');
        }
    }, [loadEntries]);

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
                <p className="muted">Sign in with your Bitcoin identity to open your vault.</p>
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
                    busy={busy}
                    error={error}
                    onUnlock={async (passphrase) => {
                        setBusy(true);
                        setError(null);
                        try {
                            const s = await send({ kind: 'unlock', passphrase });
                            setState(s);
                            await loadEntries(); // instant — from the cache
                            void refresh(); // then catch up with the server
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

    const lock = async () => {
        await send({ kind: 'lock' });
        setState({ status: 'locked', entryCount: 0, lastSyncAt: null });
        setEntries([]);
        setView('list');
        setDetailId(null);
    };

    if (view === 'settings') {
        return (
            <Shell header={<BackButton onBack={() => setView('list')} />}>
                <SettingsView onError={setError} />
                {error && <p className="error">{error}</p>}
            </Shell>
        );
    }

    if (view === 'detail' && detailId) {
        const summary = entries.find((e) => e.id === detailId);
        return (
            <Shell header={<BackButton onBack={() => setView('list')} />}>
                {summary ? (
                    <EntryDetail summary={summary} onError={setError} />
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
                    <button className="link" onClick={() => void refresh()}>
                        sync
                    </button>
                    <button className="link" onClick={() => setView('settings')}>
                        settings
                    </button>
                    <button className="link" onClick={() => void lock()}>
                        lock
                    </button>
                </div>
            }
        >
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
            {error && <p className="error">{error}</p>}
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
                                    await navigator.clipboard.writeText(value);
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
            {entries.length === 0 && (
                <div className="empty">
                    {error ? (
                        <p className="muted">Couldn&apos;t load your vault: {error}</p>
                    ) : (
                        <>
                            <p className="muted">
                                Your vault has no <strong>cloud-synced</strong> entries.
                            </p>
                            <p className="muted">
                                OC Vault fills credentials that are synced to your OrangeCheck
                                account. If your entries live only in the web app on one device,
                                turn on cloud sync at vault.ochk.io — then they appear here, and
                                autofill works.
                            </p>
                            <a
                                className="btn"
                                href="https://vault.ochk.io"
                                target="_blank"
                                rel="noreferrer"
                            >
                                open vault.ochk.io
                            </a>
                        </>
                    )}
                </div>
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

function EntryDetail({
    summary,
    onError,
}: {
    summary: VaultEntrySummary;
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
                                        await navigator.clipboard.writeText(value);
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

function SettingsView({ onError }: { onError: (message: string | null) => void }) {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

    useEffect(() => {
        void send({ kind: 'get-settings' })
            .then(setSettings)
            .catch(() => undefined);
    }, []);

    const update = async (next: Settings) => {
        setSettings(next);
        try {
            await send({ kind: 'set-settings', settings: next });
            onError(null);
        } catch (err) {
            onError(err instanceof Error ? err.message : 'could not save settings');
        }
    };

    return (
        <div className="settings">
            <label className="setting">
                <span>auto-lock when idle</span>
                <select
                    value={settings.idleLockMinutes}
                    onChange={(e) => void update({ idleLockMinutes: Number(e.target.value) })}
                >
                    {IDLE_LOCK_CHOICES.map((m) => (
                        <option key={m} value={m}>
                            {m === 0 ? 'never' : `${m} min`}
                        </option>
                    ))}
                </select>
            </label>
            <p className="muted">
                The vault also locks whenever the browser suspends the extension — your key is held
                only in memory, never stored.
            </p>
        </div>
    );
}

function UnlockGate({
    busy,
    error,
    onUnlock,
}: {
    busy: boolean;
    error: string | null;
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
            <p className="muted">Enter your vault passphrase to unlock.</p>
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
        </form>
    );
}
