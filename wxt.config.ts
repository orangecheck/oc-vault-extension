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
            gecko: { id: 'vault@ochk.io' },
        },
    },
});
