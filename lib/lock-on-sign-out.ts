/**
 * Run a worker request. If it finds the person signed out of vault.ochk.io
 * (a 401), answer with `onSignedOut()` instead, which drops the key: the
 * extension keeps no vault open for an account that is no longer signed in.
 * Any other failure is the caller's, unchanged.
 */
export async function lockOnSignOut<T, U>(
    run: () => Promise<T>,
    isSignedOut: (err: unknown) => boolean,
    onSignedOut: () => U
): Promise<T | U> {
    try {
        return await run();
    } catch (err) {
        if (isSignedOut(err)) return onSignedOut();
        throw err;
    }
}
