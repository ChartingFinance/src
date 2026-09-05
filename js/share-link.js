/**
 * share-link.js — the portfolio share link, in one place.
 *
 * ── Why this module exists ───────────────────────────────────────────
 *
 * The encoding used to live inside `<share-modal>`, next to a mailto: form and
 * a Lit render tree. That was fine while a link could only ever be made by a
 * person clicking a button in the browser. It stopped being fine when the MCP
 * server needed to hand back the same link for a plan it had just run: a second
 * encoder would have been a second definition of the share format, guarding the
 * first, which is the failure this repository keeps finding in itself. So the
 * format lives here, and both callers import it.
 *
 * It is deliberately DOM-free — no window, no document, no localStorage — so the
 * headless server can import it without dragging the app in behind it.
 *
 * ── The fragment, not the query ──────────────────────────────────────
 *
 * Links are built as `#portfolio=…`, not `?portfolio=…`.
 *
 * A query string is part of the HTTP request line. Sharing a plan that way
 * sends the whole portfolio — every balance, every date — to the web server,
 * and to whatever CDN or proxy logs sit in front of it. That is a strange thing
 * for a tool whose first promise is that nothing leaves your machine.
 *
 * A fragment is never transmitted. The browser keeps it, the page reads it from
 * `location.hash`, and the portfolio stays on the two machines that already had
 * it. Same link, same behaviour on arrival, one fewer party.
 *
 * Query links are still ACCEPTED — every link mailed before this change is one —
 * but no new link is built that way.
 *
 * ── About `+` ────────────────────────────────────────────────────────
 *
 * `compressToEncodedURIComponent` emits `+` (32–64 of them in a typical plan).
 * Read back through `URLSearchParams`, those become spaces — and it still works,
 * because lz-string turns spaces back into `+` on the way in. Verified against
 * three profiles rather than assumed, since it looks exactly like a bug. Do not
 * "fix" it by escaping the payload: that breaks the links already in the world.
 */

import LZString from 'lz-string';

/** The parameter name, in both the fragment and the legacy query. */
export const SHARE_PARAM = 'portfolio';

/**
 * A run handle: `plan_` followed by ten hex characters (mcp/run-plan.js mints
 * these from a sha1 of the spec).
 *
 * Anchored, and it has to be: this is what tells a handle apart from a
 * compressed payload, and the separation only holds because `_` is not in
 * lz-string's URI-safe alphabet. tests/share-link.mjs asserts that premise
 * rather than trusting it.
 */
export const PLAN_HANDLE_RE = /^plan_[0-9a-f]{10}$/;

/**
 * What did the user paste?
 *
 * Handle first — it is the strictest pattern and cannot collide. Then anything
 * carrying a scheme or starting at the fragment or query is a URL. Everything
 * else is treated as a bare payload, which is the shape you get when someone
 * copies the part after the "#" by itself.
 */
export function classifyPlanReference(text) {
    const s = String(text ?? '').trim();
    if (!s) return { kind: 'empty', value: s };
    if (PLAN_HANDLE_RE.test(s)) return { kind: 'handle', value: s };
    if (s.includes('://') || s.startsWith('#') || s.startsWith('?')) return { kind: 'url', value: s };
    return { kind: 'payload', value: s };
}

/** Where a link points when the caller does not say. */
export const DEFAULT_ORIGIN = 'https://charting.finance/';

/**
 * A length past which a link is worth mentioning, NOT refusing.
 *
 * An earlier draft refused above ~8 KB, reasoning about the request-line limits
 * that make a long query 414. The fragment removed that ceiling — nothing is
 * sent — so what is left is soft: address bars, and mail clients that truncate a
 * long mailto:. The eight built-in profiles measure 3.5–5.4 KB, roughly 450
 * chars per asset, so this is far above any plan seen so far and exists to make
 * a genuinely enormous one visible rather than to stop it.
 */
export const SHARE_URL_SOFT_LIMIT = 16000;

/**
 * The share payload: what the app's importer reads, key for key.
 *
 * A plan spec ALREADY has this shape — `planFromProfile` returns exactly these
 * five keys — so this is a normalisation, not a translation. Anything else on
 * the spec is dropped rather than shipped, because the importer would ignore it
 * and a link should not carry what it cannot deliver.
 */
/**
 * The five keys that ARE the plan.
 *
 * Load-bearing, because a run handle is a content address over the spec: any
 * extra key changes the hash. A link may carry more than a plan — see `handle`
 * below — and everything outside this set has to be stripped before the spec
 * reaches the engine, or a plan sent out and read back would report a different
 * handle than the one it left with, which is precisely the divergence the round
 * trip exists to disprove.
 */
export const SPEC_KEYS = ['name', 'settings', 'modelAssets', 'lifeEvents', 'guardrailParams'];

export function sharePayloadFromPlan(spec, { name, handle } = {}) {
    if (!spec?.modelAssets?.length) {
        throw new Error('Cannot build a share link for a plan with no assets.');
    }
    const payload = {
        name:            name ?? spec.name ?? 'Shared Portfolio',
        settings:        spec.settings ?? {},
        modelAssets:     spec.modelAssets,
        lifeEvents:      spec.lifeEvents ?? [],
        guardrailParams: spec.guardrailParams ?? null,
    };

    // PROVENANCE, not identity. The handle names the run this link was minted
    // from, so the app can say which report it corresponds to — the check that
    // would have caught both bugs in the round-trip notes at a glance. It is
    // deliberately not part of the spec: edit the plan after importing and the
    // handle still describes where it came from, not what it is now. Omitted
    // entirely when absent, so a link from the app's own Share button — which
    // has no handle to give — stays exactly the five keys it always was.
    if (handle) payload.handle = handle;

    return payload;
}

/**
 * The spec inside a payload, with anything that is not the plan removed.
 *
 * Call this on the way IN. `planFromShareUrl` returns what the link carried,
 * which the app wants whole; the engine must only ever see the five keys.
 */
export function specFromPayload(payload) {
    if (!payload) return payload;
    const spec = {};
    for (const k of SPEC_KEYS) if (k in payload) spec[k] = payload[k];
    return spec;
}

export function encodeSharePayload(payload) {
    return LZString.compressToEncodedURIComponent(JSON.stringify(payload));
}

/** null — never a throw — for anything that does not decode to an object. */
export function decodeSharePayload(compressed) {
    if (!compressed) return null;
    try {
        const json = LZString.decompressFromEncodedURIComponent(compressed);
        if (!json) return null;
        const data = JSON.parse(json);
        return (data && typeof data === 'object') ? data : null;
    } catch {
        return null;
    }
}

/**
 * A plan spec to a link.
 *
 * Returns the length alongside the URL so a caller can say something about it
 * instead of discovering the size in a truncated mail client.
 */
export function shareUrlFromPlan(spec, { origin = DEFAULT_ORIGIN, name, handle } = {}) {
    const payload = sharePayloadFromPlan(spec, { name, handle });
    const compressed = encodeSharePayload(payload);
    const url = `${origin}#${SHARE_PARAM}=${compressed}`;
    return {
        url,
        length: url.length,
        oversize: url.length > SHARE_URL_SOFT_LIMIT,
        assetCount: payload.modelAssets.length,
        name: payload.name,
    };
}

/**
 * Pull the compressed payload out of a location, fragment first.
 *
 * Takes the two pieces rather than a `window`, so the server and the tests can
 * call it with strings. Either may be empty.
 */
export function sharePayloadParamFrom(search = '', hash = '') {
    const fromHash = String(hash).replace(/^#/, '');
    // A plain split, not URLSearchParams: the fragment is ours, and hand-parsing
    // it keeps `+` intact instead of relying on a second round of substitution.
    for (const part of fromHash.split('&')) {
        const eq = part.indexOf('=');
        if (eq > 0 && part.slice(0, eq) === SHARE_PARAM) return part.slice(eq + 1);
    }
    const params = new URLSearchParams(String(search));
    return params.get(SHARE_PARAM);   // legacy links, mailed before the fragment
}

/** A whole URL back to a payload, for tests and for anything holding a link. */
export function planFromShareUrl(url) {
    const hashAt = String(url).indexOf('#');
    const queryAt = String(url).indexOf('?');
    const hash = hashAt >= 0 ? url.slice(hashAt) : '';
    const search = queryAt >= 0 ? url.slice(queryAt, hashAt >= 0 ? hashAt : undefined) : '';
    return decodeSharePayload(sharePayloadParamFrom(search, hash));
}
