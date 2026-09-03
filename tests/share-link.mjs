/**
 * share-link.mjs — the share format, and the promise it makes.
 *
 * ── What is actually at stake ────────────────────────────────────────
 *
 * A share link carries the whole portfolio: every balance, every date. The
 * plugin's README promises that nothing leaves the machine, and the difference
 * between that being true and false is one character — `#` versus `?`. A query
 * string is part of the HTTP request line and reaches the web server and its
 * logs; a fragment is never transmitted.
 *
 * Nothing about the app breaks if someone changes it back. The link still
 * opens, the plan still imports, every other test still passes, and the only
 * casualty is a claim made in a README. So the fragment is asserted here
 * directly, as the property it is, rather than left to be inferred from
 * behaviour that does not change.
 *
 * The second property is that there is ONE encoder. This started as a private
 * method inside a Lit modal, and the MCP tool needed the same bytes; a copy
 * would have been a second definition of the format, which is the failure this
 * repository keeps finding in itself. The import check below is what keeps that
 * from drifting back.
 *
 * Run: node tests/share-link.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.window = globalThis;

const {
  shareUrlFromPlan, planFromShareUrl, sharePayloadParamFrom,
  decodeSharePayload, encodeSharePayload, sharePayloadFromPlan,
  SHARE_PARAM, DEFAULT_ORIGIN,
} = await import('../js/share-link.js');
const { planFromProfile, listProfiles, cacheRun, specForHandle, clearRuns } =
  await import('../js/mcp/run-plan.js');

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

// ── The privacy property ─────────────────────────────────────────────
console.log('\n── The link keeps the portfolio off the wire ──\n');

const link = shareUrlFromPlan(planFromProfile('preRetirement'));

check('a new link carries the plan in the FRAGMENT', () => {
  assert.ok(link.url.includes(`#${SHARE_PARAM}=`),
    `link has no #${SHARE_PARAM}= fragment: ${link.url.slice(0, 80)}…`);
});

check('a new link carries NOTHING in the query string', () => {
  // The whole point. A query string is sent to the server; a fragment is not.
  const beforeHash = link.url.split('#')[0];
  assert.ok(!beforeHash.includes('?'),
    `the portfolio is in the query string, which is transmitted: ${beforeHash.slice(0, 80)}…`);
  assert.ok(!beforeHash.includes(SHARE_PARAM),
    'the share parameter appears before the fragment marker');
});

check('the default destination is the real site', () => {
  assert.ok(link.url.startsWith(DEFAULT_ORIGIN), `starts with ${link.url.slice(0, 40)}`);
});

// ── Round trip ───────────────────────────────────────────────────────
console.log('\n── Every profile survives the round trip ──\n');

for (const p of listProfiles()) {
  check(`${p.key} encodes and decodes unchanged`, () => {
    const spec = planFromProfile(p.key);
    const back = planFromShareUrl(shareUrlFromPlan(spec).url);
    assert.ok(back, 'decoded to null');
    assert.equal(back.modelAssets.length, spec.modelAssets.length, 'asset count moved');
    assert.deepEqual(back.settings, spec.settings, 'settings moved');
    assert.equal(back.lifeEvents.length, (spec.lifeEvents ?? []).length, 'life event count moved');
    // The five keys the importer reads, and nothing invented.
    assert.deepEqual(Object.keys(back).sort(),
      ['guardrailParams', 'lifeEvents', 'modelAssets', 'name', 'settings']);
  });
}

// ── `+` in the payload ───────────────────────────────────────────────
console.log('\n── The payload contains + and both paths tolerate it ──\n');

check('compressed payloads really do contain +', () => {
  // If this ever stops being true the next check proves nothing, so it is
  // asserted rather than assumed — the same reason niit-visibility asserts that
  // some fixture actually owes NIIT.
  const compressed = encodeSharePayload(sharePayloadFromPlan(planFromProfile('midCareer')));
  assert.ok(compressed.includes('+'), 'no + in the payload — this suite is now vacuous');
});

check('a legacy query link still decodes, + and all', () => {
  const spec = planFromProfile('midCareer');
  const compressed = encodeSharePayload(sharePayloadFromPlan(spec));
  const legacy = `${DEFAULT_ORIGIN}?${SHARE_PARAM}=${compressed}`;
  const back = planFromShareUrl(legacy);
  assert.ok(back, 'a link mailed before the fragment change no longer opens');
  assert.equal(back.modelAssets.length, spec.modelAssets.length);
});

// ── Which one wins ───────────────────────────────────────────────────
console.log('\n── Reading a location ──\n');

check('the fragment is preferred over the query', () => {
  const mine = encodeSharePayload({ name: 'fragment', modelAssets: [], lifeEvents: [] });
  const theirs = encodeSharePayload({ name: 'query', modelAssets: [], lifeEvents: [] });
  const got = sharePayloadParamFrom(`?${SHARE_PARAM}=${theirs}`, `#${SHARE_PARAM}=${mine}`);
  assert.equal(decodeSharePayload(got).name, 'fragment');
});

check('a location with neither yields null', () => {
  assert.equal(sharePayloadParamFrom('', ''), null);
  assert.equal(sharePayloadParamFrom('?other=1', '#unrelated'), null);
});

check('garbage decodes to null rather than throwing', () => {
  assert.equal(decodeSharePayload('not-a-real-payload'), null);
  assert.equal(decodeSharePayload(''), null);
  assert.equal(planFromShareUrl('https://charting.finance/#portfolio=%%%'), null);
});

// ── Refusals ─────────────────────────────────────────────────────────
console.log('\n── It refuses what it cannot deliver ──\n');

check('a plan with no assets is refused, not encoded', () => {
  assert.throws(() => shareUrlFromPlan({ modelAssets: [] }), /no assets/);
});

check('an unknown handle names the ones that exist', () => {
  clearRuns();
  assert.throws(() => specForHandle('plan_nope'), /No plan has been run yet/);
  const spec = planFromProfile('retired');
  const handle = cacheRun(spec, {}, null);
  assert.equal(specForHandle(handle).modelAssets.length, spec.modelAssets.length,
    'a cached handle did not resolve to its own spec');
});

check('resolving a handle for a link does NOT require a run', () => {
  // cacheRun above registered the spec with a null result. If building a link
  // needed the simulation, this is where it would have to run one.
  clearRuns();
  const handle = cacheRun(planFromProfile('midCareer'), {}, null);
  const url = shareUrlFromPlan(specForHandle(handle)).url;
  assert.ok(url.includes(`#${SHARE_PARAM}=`));
});

// ── One encoder ──────────────────────────────────────────────────────
console.log('\n── There is exactly one encoder ──\n');

check('only share-link.js imports lz-string', () => {
  const offenders = [];
  for (const f of ['js/finplan-app.js', 'js/components/share-modal.js', 'js/mcp/mcp-server.js']) {
    if (/from ['"]lz-string['"]/.test(readFileSync(f, 'utf8'))) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `these import lz-string directly and can encode a second, divergent share format: ${offenders}`);
});

check('the share modal builds its URL through the shared module', () => {
  const src = readFileSync('js/components/share-modal.js', 'utf8');
  assert.ok(/from ['"]\.\.\/share-link\.js['"]/.test(src),
    'share-modal.js does not import share-link.js');
  assert.ok(!/compressToEncodedURIComponent/.test(src),
    'share-modal.js still compresses its own payload');
});

check('the app reads the URL through the shared module', () => {
  const src = readFileSync('js/finplan-app.js', 'utf8');
  assert.ok(/sharePayloadParamFrom/.test(src),
    'finplan-app.js does not use sharePayloadParamFrom — it may still read only location.search');
  assert.ok(/window\.location\.hash/.test(src),
    'finplan-app.js never looks at the fragment, so no fragment link can open');
});

check('the app handles a fragment link arriving in an already-open tab', () => {
  // The query form got this free — a different query string is a different
  // document, so the page reloaded and init ran. A fragment change fires
  // `hashchange` and nothing else. Measured in the browser: with the app open,
  // the URL carried a 446-character payload and no prompt appeared.
  const src = readFileSync('js/finplan-app.js', 'utf8');
  assert.ok(/addEventListener\(\s*['"]hashchange['"]/.test(src),
    'no hashchange listener: a share link pasted into an open tab silently does nothing');
  const listener = src.slice(src.indexOf("addEventListener('hashchange'"));
  assert.ok(/loadSharedPortfolio\(\)/.test(listener.slice(0, 200)),
    'the hashchange listener does not call loadSharedPortfolio');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
