// @ts-check

/**
 * Thin wrappers around the Wayfern CDP domain. The patched browser
 * exposes (among others) `Wayfern.refreshFingerprint` and
 * `Wayfern.getFingerprint`. Both go through a CDP session attached to
 * a page.
 *
 * The PDL definition lives at:
 *   wayfern/patches/extra/fingerprint/new-content-browser-devtools-wayfern.pdl.patch
 */

/**
 * @typedef {import("playwright").Page} Page
 * @typedef {import("playwright").CDPSession} CDPSession
 */

/**
 * @typedef {Object} RefreshFingerprintOptions
 * @prop {"windows"|"macos"|"linux"|"android"|"ios"} [operatingSystem] Target OS for the regenerated fingerprint.
 * @prop {string} [timezone] IANA tz override (used when the geo service can't auto-detect, e.g. proxied connections).
 * @prop {string} [language] BCP 47 primary language override.
 * @prop {number} [latitude] Geolocation latitude override.
 * @prop {number} [longitude] Geolocation longitude override.
 * @prop {string} [wayfernToken] Cross-OS authorization token for paid users.
 */

/**
 * @typedef {Object} Fingerprint A loosely-typed view of the fingerprint payload.
 *   The full schema is large; see the PDL file for the canonical list. Fields
 *   that are stored as JSON-encoded strings on the wire (fonts, plugins, etc.)
 *   are returned as-is — the caller can JSON.parse them when needed.
 */

export class WayfernCdp {
    /**
     * @param {Page} page
     * @param {{ session?: CDPSession }} [options] Pre-existing CDP session — if omitted, a new one is created and reused.
     */
    constructor(page, options = {}) {
        this.page = page;
        /** @type {CDPSession | null} */
        this.session = options.session ?? null;
    }

    /**
     * Lazily create the CDP session. Reused across calls to avoid
     * spinning a new WebSocket per command.
     */
    async _getSession() {
        if (this.session) return this.session;
        this.session = await this.page.context().newCDPSession(this.page);
        return this.session;
    }

    /**
     * Regenerate the browser fingerprint. When the page sits behind a
     * proxy whose creds the C++ geo service can't see (HTTP 407), pass
     * `timezone`/`language`/`latitude`/`longitude` directly.
     *
     * @param {RefreshFingerprintOptions} [params]
     * @returns {Promise<unknown>}
     */
    async refreshFingerprint(params = {}) {
        const session = await this._getSession();
        // Cast through `any` because Playwright's CDPSession.send is
        // typed against the official protocol, not the Wayfern domain.
        return /** @type {any} */ (session).send("Wayfern.refreshFingerprint", params);
    }

    /**
     * Read the active fingerprint. The CDP response is shaped as
     * `{ fingerprint: {...} }` — this method returns the inner object
     * directly so callers don't have to unwrap it.
     *
     * @returns {Promise<Fingerprint>}
     */
    async getFingerprint() {
        const session = await this._getSession();
        const result = /** @type {any} */ (
            await /** @type {any} */ (session).send("Wayfern.getFingerprint")
        );
        return result?.fingerprint ?? result;
    }

    /**
     * Send any Wayfern.* (or other) CDP method on the same session.
     * Useful for `setFingerprint`, `enableInputCapture`, etc., without
     * needing to allocate a separate session.
     *
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     * @returns {Promise<unknown>}
     */
    async send(method, params = {}) {
        const session = await this._getSession();
        return /** @type {any} */ (session).send(method, params);
    }

    async detach() {
        if (this.session) {
            await this.session.detach().catch(() => {});
            this.session = null;
        }
    }
}
