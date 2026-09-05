/**
 * plan-reference.js — the return leg.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * `run_plan`'s description has always said its format "is exactly what the
 * Charting Finance app's Share link encodes". The outbound leg shipped with
 * `share_link`; the inbound one did not, so a session could hand out a link and
 * then be unable to read its own link back. Someone drags a life event in the
 * browser, hits Share, pastes the URL — and until now there was nothing to pass
 * it to.
 *
 * ── Why it lives here and not in run-plan.js ─────────────────────────
 *
 * `js/mcp/run-plan.js` is a layer-boundary ENTRY POINT: its import closure is
 * the run path, and the run path is asserted to import no third-party package.
 * Reaching share-link.js from there would pull lz-string onto the run path and
 * fail that check — correctly, because decoding a share link is not something
 * computing a plan should ever need to do. So the two are joined here, one
 * level out, where the server already depends on both.
 *
 * ── Three shapes, told apart by one character ────────────────────────
 *
 * A caller pastes whatever they have. That is a share URL, a bare compressed
 * payload, or a run handle, and they are unambiguous:
 *
 *   plan_688bcae498     a handle    `plan_` + 10 hex
 *   https://…#portfolio=N4Igdg…     a URL       contains a scheme or starts at the fragment
 *   N4Igdghgtgpi…       a payload   anything else
 *
 * The discrimination is safe because `_` is not in lz-string's URI-safe
 * alphabet at all — measured across all eight profiles and 3,000 random
 * payloads, zero occurrences — so no compressed payload can ever match the
 * handle pattern. Checked in tests/share-link.mjs, including the premise.
 *
 * ── Handles are session-scoped, and that is the real limit ───────────
 *
 * A handle resolves out of the server's in-memory SPECS map, so it is valid for
 * as long as the process lives and meaningless afterwards or on anyone else's
 * machine. A share URL carries the whole plan and always works. Callers should
 * prefer the handle inside a session for its size, and the URL for anything
 * that has to survive one — the error below says so rather than leaving someone
 * to guess why a handle from yesterday is gone.
 */

import { classifyPlanReference, planFromShareUrl, decodeSharePayload, specFromPayload }
    from '../share-link.js';
import { specForHandle } from './run-plan.js';

/**
 * Anything a user can paste, to a plan spec.
 *
 * Throws with the reason rather than returning null: every failure here has a
 * different fix, and "could not read that" would flatten a dead handle, a
 * truncated link and a typo into one unhelpful sentence.
 */
export function planFromReference(text) {
    const { kind, value } = classifyPlanReference(text);

    switch (kind) {
        case 'handle':
            // Throws its own message naming the live handles, which is more
            // useful than anything that could be written here.
            return specForHandle(value);

        case 'url': {
            const payload = planFromShareUrl(value);
            if (!payload) {
                throw new Error(
                    'That looks like a share link, but no plan could be read out of it. '
                    + 'The payload lives after the "#" — if the link was pasted from an email '
                    + 'or a chat it may have been truncated or line-wrapped.');
            }
            // specFromPayload, not the payload: a link may carry provenance —
            // the handle it was minted from — and the handle is a hash OVER the
            // spec, so shipping that field into the engine would give the same
            // plan a different content address every trip.
            return specFromPayload(payload);
        }

        case 'payload': {
            const payload = decodeSharePayload(value);
            if (!payload) {
                throw new Error(
                    'That is not a plan, a share link, or a run handle. A handle looks like '
                    + '"plan_688bcae498"; a share link contains "#portfolio=" followed by a '
                    + 'long compressed string.');
            }
            return specFromPayload(payload);
        }

        default:
            throw new Error('No plan reference given — pass a share link, a share payload, '
                          + 'or a run handle.');
    }
}
