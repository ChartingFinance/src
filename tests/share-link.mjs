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
 * The third is that a link opens in the app as the plan it carries, on the
 * settings the MCP server ran it with, or the import dialog says why it cannot.
 * A failure in between leaves the previous plan on screen looking like the
 * shared one, and nothing about that screen says otherwise.
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
  SHARE_PARAM, DEFAULT_ORIGIN, classifyPlanReference, SPEC_KEYS, specFromPayload,
} = await import('../js/share-link.js');
const { planFromProfile, listProfiles, cacheRun, specForHandle, clearRuns, simConfigFromPlanSpec } =
  await import('../js/mcp/run-plan.js');
const { readSharedPlan, applySharedSettings } = await import('../js/shared-plan.js');
const { SIM_CONFIG_DEFAULTS } = await import('../js/sim-config.js');
const G = await import('../js/globals.js');

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

// ── Telling the three shapes apart ───────────────────────────────────
console.log('\n── A pasted reference is classified without ambiguity ──\n');

check('a handle is recognised, and a payload is never mistaken for one', () => {
  assert.equal(classifyPlanReference('plan_688bcae498').kind, 'handle');
  assert.equal(classifyPlanReference('  plan_37511aab01  ').kind, 'handle');
  // The premise the whole discrimination rests on, asserted rather than assumed:
  // `_` is not in lz-string's URI-safe alphabet, so no payload can look like a
  // handle. If that ever changes, this fails before anything silently misroutes.
  for (const p of listProfiles()) {
    const payload = encodeSharePayload(sharePayloadFromPlan(planFromProfile(p.key)));
    assert.ok(!payload.includes('_'), `${p.key}'s payload contains an underscore`);
    assert.equal(classifyPlanReference(payload).kind, 'payload');
  }
});

check('a near-miss handle is not treated as one', () => {
  // Anchored and exact-length: a truncated or over-long id is a typo, not a
  // handle, and must not be sent to the resolver as if it were.
  assert.notEqual(classifyPlanReference('plan_688bcae4').kind, 'handle');
  assert.notEqual(classifyPlanReference('plan_688bcae4980').kind, 'handle');
  assert.notEqual(classifyPlanReference('plan_688bcaeZZZ').kind, 'handle');
  assert.notEqual(classifyPlanReference('PLAN_688bcae498').kind, 'handle');
});

check('links are recognised in every form they get pasted in', () => {
  assert.equal(classifyPlanReference('https://charting.finance/#portfolio=abc').kind, 'url');
  assert.equal(classifyPlanReference('http://localhost:5173/#portfolio=abc').kind, 'url');
  assert.equal(classifyPlanReference('#portfolio=abc').kind, 'url');
  assert.equal(classifyPlanReference('?portfolio=abc').kind, 'url');
  assert.equal(classifyPlanReference('').kind, 'empty');
  assert.equal(classifyPlanReference(null).kind, 'empty');
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

check('a link omits the handle unless one is given', () => {
  // The app's own Share button has no handle to give, and a `handle: null` in
  // the payload would be a field claiming provenance it does not have.
  const spec = planFromProfile('retired');
  const plain = planFromShareUrl(shareUrlFromPlan(spec).url);
  assert.ok(!('handle' in plain), 'a handle-less link carries a handle key anyway');
  assert.deepEqual(Object.keys(plain).sort(), [...SPEC_KEYS].sort());

  const withRun = planFromShareUrl(shareUrlFromPlan(spec, { handle: 'plan_abc1234567' }).url);
  assert.equal(withRun.handle, 'plan_abc1234567');
  assert.ok(!('handle' in specFromPayload(withRun)), 'specFromPayload left the provenance in');
});

check('the app shows which run an imported plan came from', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(/id="importedRunBadge"/.test(html), 'no run badge on the portfolio header');
  assert.ok(/id="import-run-provenance"/.test(html), 'the import dialog says nothing about the run');

  const src = readFileSync('js/finplan-app.js', 'utf8');

  // The badge is set by the IMPORT, the dialog line by the OFFER. Setting both
  // when the dialog opens put a run handle on the portfolio header while the
  // user was still deciding — caught in a screenshot, not by an assertion,
  // because both surfaces did get set. So the two sites are asserted apart.
  const offer = src.slice(src.indexOf('function loadSharedPortfolio'));
  assert.ok(/setImportDialogRun\(data\.handle\)/.test(offer.slice(0, 1600)),
    'the import dialog never says which run the link came from');
  assert.ok(!/setImportedRunBadge/.test(offer.slice(0, 1600)),
    'the portfolio badge is set while the user is still deciding whether to import');

  const applied = src.slice(src.indexOf('function applyImportedPortfolio'));
  assert.ok(/setImportedRunBadge\(plan\.handle\)/.test(applied.slice(0, 400)),
    'importing a plan does not record which run it came from');

  // Cleared when the plan on screen is no longer the imported one.
  assert.ok(/setImportedRunBadge\(null\)/.test(src),
    'nothing ever clears the badge, so it outlives the plan it describes');

  // "from run", not "run": it stays true after the plan is edited, and claiming
  // a live identity it cannot maintain is worse than claiming nothing.
  assert.ok(/from run \$\{handle\}/.test(src),
    'the badge asserts a live identity rather than provenance');
});

check('the app handles a fragment link arriving in an already-open tab', () => {
  // A different query string is a different document, so the page reloads
  // and init runs. A fragment change fires `hashchange` and nothing else, so
  // without a listener a link pasted into an open tab shows no prompt.
  const src = readFileSync('js/finplan-app.js', 'utf8');
  assert.ok(/addEventListener\(\s*['"]hashchange['"]/.test(src),
    'no hashchange listener: a share link pasted into an open tab silently does nothing');
  const listener = src.slice(src.indexOf("addEventListener('hashchange'"));
  assert.ok(/loadSharedPortfolio\(\)/.test(listener.slice(0, 200)),
    'the hashchange listener does not call loadSharedPortfolio');
});

// ── Opening a link ───────────────────────────────────────────────────
console.log('\n── A link opens as the plan it carries, or says why it cannot ──\n');

/** A link's payload, decoded the way the app decodes its own address. */
const arrive = (url) => {
  const u = new URL(url);
  return decodeSharePayload(sharePayloadParamFrom(u.search, u.hash));
};

/**
 * Settings the viewer already had, none of them a default, so a setting the
 * import fails to move shows up as the viewer's rather than passing unnoticed.
 */
function viewerHasOtherSettings() {
  for (const k of Object.keys(store)) delete store[k];
  G.global_setInflationRate(0.05);
  G.global_setFilingAs('MFJ');
  G.global_setUserStartAge(45);
  G.global_setUserRetirementAge(62);
  G.global_setUserFinishAge(90);
  G.global_setGuardrailPreservation(20);
}

// The link a run_plan spec with partial settings shares: no inflationRate.
const partial = planFromProfile('preRetirement');
partial.settings = { filingAs: 'Single', startAge: 60, retirementAge: 67, finishAge: 65 };
const partialLink = shareUrlFromPlan(partial, { origin: 'http://localhost:5173/' }).url;

check('a link that leaves a setting out is read with the engine default in its place', () => {
  const payload = arrive(partialLink);
  assert.ok(!('inflationRate' in payload.settings),
    'the link carries an inflationRate, so this check no longer tests anything');
  assert.deepEqual({ ...readSharedPlan(payload).settings }, {
    inflationRate: SIM_CONFIG_DEFAULTS.inflationRate,
    filingAs: 'Single', startAge: 60, retirementAge: 67, finishAge: 65,
  });
});

check('opening it moves every setting, including the one it left out', () => {
  // The import used to pass the payload's undefined inflationRate to
  // global_setInflationRate, which threw and left the previous plan on screen.
  viewerHasOtherSettings();
  applySharedSettings(readSharedPlan(arrive(partialLink)));
  assert.equal(G.global_inflationRate, SIM_CONFIG_DEFAULTS.inflationRate,
    "inflation is still the viewer's 5%, so the plan on screen is not the link's");
  assert.equal(store.inflationRate, '0.0310', 'the stored inflation rate did not move');
  assert.deepEqual(
    [G.global_filingAs, G.global_user_startAge, G.global_user_retirementAge, G.global_user_finishAge],
    ['Single', 60, 67, 65]);
});

check('the app opens a link on the settings the MCP server runs it on', () => {
  // One reading of a link's settings, used by both. If either side grows its
  // own defaulting, a shared plan and its report describe different plans.
  const base = sharePayloadFromPlan(partial);
  const { settings: _, ...withoutSettings } = base;
  const payloads = {
    'one left out': base,
    'all present': { ...base, settings: { inflationRate: 0.042, filingAs: 'MFJ',
                                          startAge: 55, retirementAge: 65, finishAge: 85 } },
    'sent as null': { ...base, settings: { ...partial.settings, inflationRate: null } },
    'empty': { ...base, settings: {} },
    'absent': withoutSettings,
    'unknown filing status': { ...base, settings: { filingAs: 'Married', startAge: 58 } },
  };
  for (const [label, payload] of Object.entries(payloads)) {
    const app = readSharedPlan(payload).settings;
    const server = simConfigFromPlanSpec(specFromPayload(payload));
    for (const key of ['inflationRate', 'filingAs', 'startAge', 'retirementAge', 'finishAge']) {
      assert.equal(app[key], server[key],
        `${label}: the app opens ${key} as ${app[key]}, the server ran ${server[key]}`);
    }
  }
});

check('a link that cannot be opened is refused with its reason, and nothing is applied', () => {
  const base = sharePayloadFromPlan(partial);
  const refused = [
    [{ ...base, settings: { ...partial.settings, inflationRate: '3%' } }, /inflationRate setting is "3%"/],
    [{ ...base, modelAssets: [] }, /no assets/],
    [{ name: 'Settings only', settings: partial.settings }, /no assets/],
    [{ ...base, modelAssets: [{ displayName: 'Half an asset' }] }, /An asset in the link/],
    [{ ...base, lifeEvents: [null] }, /A life event in the link/],
  ];
  viewerHasOtherSettings();
  const before = JSON.stringify(store);
  for (const [payload, reason] of refused) {
    assert.throws(() => readSharedPlan(payload), reason);
  }
  assert.equal(JSON.stringify(store), before, 'reading a link changed the stored settings');
});

check('guardrail parameters a link leaves out take the defaults instead of throwing', () => {
  viewerHasOtherSettings();
  const plan = readSharedPlan({ ...sharePayloadFromPlan(partial), guardrailParams: { withdrawalRate: 4 } });
  applySharedSettings(plan);
  assert.equal(G.global_guardrail_withdrawalRate, 4);
  assert.equal(G.global_guardrail_preservation, G.global_default_guardrail_preservation,
    "preservation kept the viewer's 20%");
  assert.equal(G.global_guardrail_prosperity, G.global_default_guardrail_prosperity);
  assert.equal(G.global_guardrail_adjustment, G.global_default_guardrail_adjustment);
});

check('the app reads a link when it arrives and applies only what was read', () => {
  // finplan-app.js needs a browser, so its half is asserted from the source.
  // Normalised because '\n}\n' (a function's closing brace) is the end marker.
  const src = readFileSync('js/finplan-app.js', 'utf8').replace(/\r\n/g, '\n');
  const between = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

  assert.ok(/readPendingImport\(decoded\)/.test(between('function loadSharedPortfolio', '\n}\n')),
    'the dialog is shown without reading the link, so a bad one fails only after Open');
  assert.ok(/readSharedPlan\(/.test(between('function readPendingImport', '\n}\n')),
    'the arriving link is not read by readSharedPlan');

  const apply = between('function applyImportedPortfolio', '\n}\n');
  assert.ok(/applySharedSettings\(plan\)/.test(apply), 'the import does not apply the read settings');
  assert.ok(!/global_set\w+\(/.test(apply),
    'the import calls a settings setter itself, with a value readSharedPlan never checked');
  assert.ok(!/\.settings\b/.test(apply), 'the import reads settings off the raw payload');
});

check('a link that cannot be opened says why, and leaves only Dismiss', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(/id="import-problem"/.test(html), 'the import dialog has nowhere to say why');

  const src = readFileSync('js/finplan-app.js', 'utf8').replace(/\r\n/g, '\n');
  const shown = src.slice(src.indexOf('function showImportProblem'));
  const body = shown.slice(0, shown.indexOf('\n}\n'));
  assert.ok(/btn-import-open'\)\.disabled = !!problem/.test(body), 'Open stays enabled on a refused link');
  assert.ok(/btn-import-save'\)\.disabled = !!problem/.test(body), 'Open & Save stays enabled on a refused link');
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
