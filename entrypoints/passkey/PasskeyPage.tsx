/**
 * The passkey window: sets up passkey unlock, or unlocks with it (lib/passkey.ts).
 *
 * It is its own small extension window, opened from the toolbar popup, because
 * the popup closes as soon as an authenticator prompt takes focus. The PRF
 * secret the passkey gives goes once to the worker, and its bytes are zeroed
 * here; the base64 string the message carries cannot be, and lives until GC.
 */

import { useEffect, useRef, useState } from 'react';

import { Mark } from '@orangecheck/app-design/brand';
import { Button, DensityProvider, Spinner } from '@orangecheck/app-design/primitives';

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
        <DensityProvider density="compact">
            <div className="flex min-h-screen flex-col bg-background text-foreground">
                <div className="flex h-12 items-center gap-2 border-b border-border px-4 text-[0.9375rem] font-medium tracking-[-0.01em]">
                    <Mark size={20} />
                    <span>
                        <span className="sr-only">OC </span>vault
                    </span>
                </div>
                <div className="flex flex-col gap-3 p-4">
                    <h1 className="oca-title-sm">
                        {op === 'enroll' ? 'Set up passkey unlock' : 'Unlock with your passkey'}
                    </h1>
                    {phase.kind === 'working' && (
                        <p
                            role="status"
                            className="flex gap-2 text-[0.8125rem] leading-relaxed text-muted-foreground"
                        >
                            <Spinner className="mt-0.5 size-4 shrink-0" />
                            {op === 'enroll'
                                ? 'Follow your browser’s prompt to make a passkey for OC Vault. Your vault key is sealed to it on this browser only.'
                                : 'Follow your browser’s prompt to use your passkey.'}
                        </p>
                    )}
                    {phase.kind === 'done' && (
                        <p role="status" className="text-sm leading-relaxed">
                            {phase.text}
                        </p>
                    )}
                    {phase.kind === 'failed' && (
                        <p
                            role="alert"
                            className="text-[0.8125rem] leading-relaxed text-destructive"
                        >
                            {phase.text}
                        </p>
                    )}
                    {phase.kind !== 'working' && (
                        <div className="flex items-center gap-2">
                            {phase.kind === 'failed' && isPasskeySupported() && (
                                <Button size="sm" onClick={run}>
                                    Try again
                                </Button>
                            )}
                            <Button variant="ghost" size="sm" onClick={() => window.close()}>
                                Close
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </DensityProvider>
    );
}
