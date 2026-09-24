/**
 * plan-reference.js — the return leg.
 *
 * Reads a plan back from what a user pastes: a share link from the app, a
 * bare payload, or a run handle.
 *
 * It lives here, not in run-plan.js: run-plan.js is on the engine's run path,
 * which must import no third-party package (tests/layer-boundary.mjs), and
 * decoding a link needs lz-string.
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
 * `_` is not in lz-string's URI-safe alphabet, so no payload can look like a
 * handle (tests/share-link.mjs checks this).
 *
 * ── Handles are session-scoped, and that is the real limit ───────────
 *
 * A handle lives in the server's memory, so it works only in the process that
 * made it. A share URL carries the whole plan and always works. Use the handle
 * within a session and the URL across sessions; the error below says so.
 */

import { classifyPlanReference, planFromShareUrl, decodeSharePayload, specFromPayload }
    from '../share-link.js';
import { specForHandle } from './run-plan.js';

/**
 * Anything a user can paste, to a plan spec.
 *
 * Throws with the reason rather than returning null: a dead handle, a
 * truncated link and a typo each need a different fix.
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
            // specFromPayload, not the payload: the link's provenance handle
            // must not reach the spec, or the plan's own handle (a hash of the
            // spec) would change on every round trip.
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
