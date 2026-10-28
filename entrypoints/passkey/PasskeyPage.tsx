/**
 * The passkey window: sets up passkey unlock, or unlocks with it (lib/passkey.ts).
 *
 * It is its own small extension window, opened from the toolbar popup, because
 * the popup closes as soon as an authenticator prompt takes focus. The PRF
 * secret the passkey gives goes once to the worker and is zeroed here.
 */

import { useEffect, useRef, useState } from 'react';

import { send } from '@/lib/messaging';
import {
    createPasskey,
    evaluatePasskey,
    isPasskeySupported,
    PRF_TEXT,
    PrfUnsupported,
} from '@/lib/passkey';
import { b64urlEncode } from '@orangecheck/lock-crypto';

export type PasskeyOp = 'enroll' | 'unlock';

/** `#enroll` sets a passkey up; anything else unlocks. */
export function passkeyOpOf(hash: string): PasskeyOp {
    return hash === '#enroll' ? 'enroll' : 'unlock';
}

type Phase =
    | { kind: 'working' }
    | { kind: 'done'; text: string }
    | { kind: 'failed'; text: string };

async function enroll(): Promise<string> {
    const state = await send({ kind: 'get-state' });
    if (state.status !== 'unlocked') {
        throw new Error(
            'Unlock the vault in the toolbar popup first, then set up the passkey there.'
        );
    }
    const { target, prfSecret } = await createPasskey();
    try {
        await send({
            kind: 'passkey-enroll',
            credentialId: target.credentialId,
            prfSalt: target.prfSalt,
            prfSecret: b64urlEncode(prfSecret),
        });
    } finally {
        prfSecret.fill(0);
    }
    return 'Passkey unlock is on. Next time, unlock the vault with it from the toolbar popup.';
}

async function unlock(): Promise<string> {
    const { target } = await send({ kind: 'passkey-status' });
    if (!target) {
        throw new Error(
            'No passkey is set up for this vault in this browser. Use your passphrase.'
        );
    }
    const prfSecret = await evaluatePasskey(target);
    if (!prfSecret) throw new Error('No passkey answered. Try again, or use your passphrase.');
    try {
        await send({ kind: 'passkey-unlock', prfSecret: b64urlEncode(prfSecret) });
    } finally {
        prfSecret.fill(0);
    }
    return 'Unlocked. Open OC Vault from the toolbar.';
}

export function PasskeyPage() {
    const op = passkeyOpOf(location.hash);
    const [phase, setPhase] = useState<Phase>({ kind: 'working' });
    const started = useRef(false);

    const run = () => {
        setPhase({ kind: 'working' });
        (op === 'enroll' ? enroll() : unlock()).then(
            (text) => {
                setPhase({ kind: 'done', text });
                if (op === 'unlock') setTimeout(() => window.close(), 1500);
            },
            (err: unknown) =>
                setPhase({
                    kind: 'failed',
                    text:
                        err instanceof PrfUnsupported
                            ? PRF_TEXT
                            : err instanceof Error
                              ? err.message
                              : 'Something went wrong. Use your passphrase.',
                })
        );
    };

    // The person asked for this in the popup a moment ago; the ceremony starts once.
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        if (isPasskeySupported()) run();
        else setPhase({ kind: 'failed', text: PRF_TEXT });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="popup">
            <div className="topbar">
                <span className="brand">
                    oc <strong>vault</strong>
                </span>
            </div>
            <div className="body">
                <p>
                    <strong>
                        {op === 'enroll' ? 'Set up passkey unlock' : 'Unlock with your passkey'}
                    </strong>
                </p>
                {phase.kind === 'working' && (
                    <p className="muted">
                        {op === 'enroll'
                            ? 'Follow your browser’s prompt to make a passkey for OC Vault. Your vault key is sealed to it on this browser only.'
                            : 'Follow your browser’s prompt to use your passkey.'}
                    </p>
                )}
                {phase.kind === 'done' && <p className="passkey-done">{phase.text}</p>}
                {phase.kind === 'failed' && <p className="error">{phase.text}</p>}
                {phase.kind !== 'working' && (
                    <div className="gen-actions">
                        {phase.kind === 'failed' && isPasskeySupported() && (
                            <button className="btn" onClick={run}>
                                try again
                            </button>
                        )}
                        <button className="link" onClick={() => window.close()}>
                            close
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
