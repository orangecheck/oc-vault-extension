import { useCallback, useEffect, useMemo, useState } from 'react';

import type { VaultEntrySummary, VaultEntryType } from '@/lib/crypto';
import { send, type VaultState } from '@/lib/messaging';

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

const SIGNIN_URL = 'https://ochk.io/signin?return_to=%2Fvault';

export function App() {
    const [state, setState] = useState<VaultState | null>(null);
    const [entries, setEntries] = useState<VaultEntrySummary[]>([]);
    const [query, setQuery] = useState('');
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
                if (s.status === 'unlocked') await loadEntries();
            } catch (err) {
                setError(err instanceof Error ? err.message : 'could not reach the vault');
            }
        })();
    }, [loadEntries]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const live = entries.filter((e) => !q || e.name.toLowerCase().includes(q));
        return live.sort(
            (a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)
        );
    }, [entries, query]);

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
                            await loadEntries();
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

    return (
        <Shell
            header={
                <button
                    className="link"
                    onClick={async () => {
                        await send({ kind: 'lock' });
                        setState({ status: 'locked', entryCount: 0, lastSyncAt: null });
                        setEntries([]);
                    }}
                >
                    lock
                </button>
            }
        >
            <input
                className="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`search ${state.entryCount} entries`}
                autoFocus
            />
            {error && <p className="error">{error}</p>}
            <ul className="entries">
                {filtered.map((entry) => (
                    <li key={entry.id} className="entry">
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
                            onClick={async () => {
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
                {filtered.length === 0 && <li className="muted">no matching entries</li>}
            </ul>
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
