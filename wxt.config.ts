import { defineConfig } from 'wxt';

/**
 * WXT configuration — see PLAN.md §2 (actors) and §8 (permissions).
 *
 * Permissions are deliberately at the Phase 0–1 minimum: `storage` for the
 * ciphertext cache + settings, and host access to the vault API and the
 * auth host only. The autofill phase adds `scripting` / `activeTab` and
 * `<all_urls>` — not before.
 */
export default defineConfig({
    modules: ['@wxt-dev/module-react'],
    manifest: {
        name: 'OC Vault',
        description:
            'Unlock once, fill anywhere, trust the origin. The browser companion to vault.ochk.io.',
        permissions: ['storage', 'alarms'],
        host_permissions: ['https://vault.ochk.io/*', 'https://ochk.io/*'],
        // No remotely-loaded code; the popup runs only its own bundle.
        content_security_policy: {
            extension_pages: "script-src 'self'; object-src 'self'",
        },
        browser_specific_settings: {
            gecko: {
                id: 'vault@ochk.io',
                // Firefox built-in data-consent declaration (AMO requires
                // this on every new MV3 submission as of 2026). The list
                // describes the data categories the extension HANDLES on
                // the user's behalf — every byte is sealed client-side
                // under a key derived from the user's passphrase before it
                // leaves the browser, so OrangeCheck only ever holds the
                // ciphertext. AMO wants the contents of that ciphertext
                // disclosed regardless.
                //
                // Chromium ignores unknown keys under gecko, so this is
                // safe in the unified Chrome/Firefox manifest.
                data_collection_permissions: {
                    required: [
                        // The whole product purpose — logins, TOTP seeds,
                        // API keys, recovery codes.
                        'authenticationInfo',
                        // The `identity` entry type (name, email, phone,
                        // address) and the signed-in OC identity itself.
                        'personallyIdentifyingInfo',
                        // The `card` entry type (cardholder, number, CVV,
                        // expiry, billing ZIP).
                        'financialAndPaymentInfo',
                        // Capture reads values the user just typed into a
                        // login form at submit time; `note` entries store
                        // user-typed page-derived content.
                        'websiteContent',
                        // Origin matching reads location.href to decide
                        // whether to offer a saved credential for the
                        // current site.
                        'websiteActivity',
                    ],
                },
            },
        },
    },
});
