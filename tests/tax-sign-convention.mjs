/**
 * tax-sign-convention.mjs — the sign is arithmetic, not decoration.
 *
 * ── The defect this exists to make impossible ────────────────────────
 *
 * `federalTaxes()` sums its components, which only works if they all point the
 * same way. Every tax field is stored NEGATIVE — money leaving — except that
 * `estimatedTaxes` was stored positive, alone, from the day it was added.
 *
 * Nothing failed. The only other reader, the annual true-up, wrapped every term
 * in Math.abs() and so agreed with itself whichever sign each field carried. The
 * one place the sign mattered was `federalTaxes()`, a display total nobody
 * reconciled — so a plan reported $87,662 of federal tax against $136,053
 * actually charged, and every suite stayed green for months.
 *
 * Three things came out of that, and this file guards all three:
 *
 *   1. THE CONVENTION IS DATA. FEDERAL_TAX_FIELDS and BIDIRECTIONAL_TAX_FIELDS
 *      live in financial-package.js and are read here. A new tax field gets a
 *      sign rule whether or not anyone remembers to write one.
 *   2. THE FUNCTION AND THE LIST MUST AGREE. A component added to
 *      federalTaxes() but not to the list — or the reverse — is the exact shape
 *      of the NIIT defect: collected correctly, reported nowhere.
 *   3. Math.abs() MUST NOT COME BACK. Its absence in the true-up is what makes
 *      a wrong sign produce a wrong number instead of being absorbed. It looks
 *      like a defensive idiom, which is why it needs a test and not a comment.
 *
 * ── On the one exception ─────────────────────────────────────────────
 *
 * `taxTrueUp` may be positive: it is the annual settlement, negative when the
 * household paid and positive when it was refunded. An exception no fixture
 * reaches is decoration, so the last check asserts a fixture actually lands on
 * the positive side.
 *
 * Run: node tests/tax-sign-convention.mjs
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

const G = await import('../js/globals.js');
const { makeActiveTaxTable, simConfigFromGlobals } = G;
const { Portfolio } = await import('../js/portfolio.js');
const { chronometer_run } = await import('../js/chronometer.js');
const { SNAPSHOT_FIXTURES } = await import('./tools/fixtures.mjs');
const { FEDERAL_TAX_FIELDS, SALT_TAX_FIELDS, BIDIRECTIONAL_TAX_FIELDS } =
  await import('../js/financial-package.js');

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); passed++; }
  catch (e) { console.log(`  ✗ ${label}`); console.log(`    ${e.message}`); failed++; }
}

// ── Run the corpus once ──────────────────────────────────────────────

const runs = [];
for (const f of SNAPSHOT_FIXTURES) {
  G.global_reset(); G.global_setAllocateHouseholdTax(false); G.global_setBacktestYearDirect?.('current');
  const c = f.config ?? {};
  if (c.startAge != null) G.global_setUserStartAge(c.startAge);
  if (c.retirementAge != null) G.global_setUserRetirementAge(c.retirementAge);
  if (c.finishAge != null) G.global_setUserFinishAge(c.finishAge);
  if (c.filingAs != null) G.global_setFilingAs(c.filingAs);
  G.setActiveTaxTable(makeActiveTaxTable());
  const built = f.build();
  const p = new Portfolio(built.assets, false, simConfigFromGlobals());
  if (built.lifeEvents) p.lifeEvents = built.lifeEvents;
  if (built.guardrails) p.guardrailsParams = built.guardrails;
  await chronometer_run(p);
  runs.push({ name: f.name, total: p.total });
}

console.log(`\n── Outflow fields never point the wrong way (${runs.length} fixtures) ──\n`);

const oneWay = [...FEDERAL_TAX_FIELDS, ...SALT_TAX_FIELDS]
  .filter(f => !BIDIRECTIONAL_TAX_FIELDS.includes(f));

for (const field of oneWay) {
  check(`${field} is never positive on a lifetime total`, () => {
    const offenders = runs
      .filter(r => (r.total[field]?.amount ?? 0) > 0.005)
      .map(r => `${r.name} (${r.total[field].amount.toFixed(2)})`);
    assert.deepEqual(offenders, [],
      `${field} is stored as an outflow and must be <= 0, but: ${offenders.join(', ')}. `
      + 'Either the field is booked with the wrong sign, or it belongs in '
      + 'BIDIRECTIONAL_TAX_FIELDS with a reason.');
  });
}

console.log('\n── The list and the function say the same thing ──\n');

check('federalTaxes() is exactly the sum of FEDERAL_TAX_FIELDS', () => {
  // Catches a component added to one and not the other, in either direction.
  // That is how NIIT shipped: collected correctly and reported nowhere.
  for (const { name, total } of runs) {
    const summed = FEDERAL_TAX_FIELDS.reduce((t, f) => t + (total[f]?.amount ?? 0), 0);
    assert.ok(Math.abs(summed - total.federalTaxes().amount) < 0.02,
      `${name}: FEDERAL_TAX_FIELDS sum to ${summed.toFixed(2)} but federalTaxes() `
      + `returns ${total.federalTaxes().amount.toFixed(2)} — the list and the function disagree`);
  }
});

check('totalTaxes() is federal plus SALT and nothing else', () => {
  for (const { name, total } of runs) {
    const summed = [...FEDERAL_TAX_FIELDS, ...SALT_TAX_FIELDS]
      .reduce((t, f) => t + (total[f]?.amount ?? 0), 0);
    assert.ok(Math.abs(summed - total.totalTaxes().amount) < 0.02,
      `${name}: declared fields sum to ${summed.toFixed(2)} but totalTaxes() returns `
      + `${total.totalTaxes().amount.toFixed(2)}`);
  }
});

console.log('\n── The sign stays load-bearing ──\n');

check('the annual true-up does not absorb the sign with Math.abs()', () => {
  // The absence of this call is the guard. It reads as a harmless defensive
  // idiom, so it is asserted rather than left to a comment.
  const src = readFileSync('js/engines/tax-engine.js', 'utf8');
  const withheld = src.slice(src.indexOf('const totalWithheld'), src.indexOf('const taxDifference'));
  assert.ok(withheld.length > 0, 'totalWithheld is gone — this check needs rewriting, not deleting');
  assert.ok(!/Math\.abs/.test(withheld),
    'Math.abs() is back in totalWithheld. It makes the arithmetic agree with itself '
    + 'whichever sign each field carries, which is what hid the estimatedTaxes '
    + 'inversion for the life of the feature.');
});

console.log('\n── The checks above are not vacuous ──\n');

check('some fixture actually books a gains provision', () => {
  const withProvision = runs.filter(r => Math.abs(r.total.estimatedTaxes.amount) > 0.005);
  assert.ok(withProvision.length > 0,
    'no fixture provisions capital-gains tax, so its sign rule proves nothing');
});

check('some fixture actually books an annual true-up', () => {
  const withTrueUp = runs.filter(r => Math.abs(r.total.taxTrueUp.amount) > 0.005);
  assert.ok(withTrueUp.length > 0,
    'no fixture settles an annual true-up, so it being in federalTaxes() is untested');
});

check('a fixture reaches the POSITIVE side of the one exception', () => {
  // Otherwise BIDIRECTIONAL_TAX_FIELDS is a rule nothing exercises, and the
  // one-way assertions above would pass just as well without the exemption.
  const refunded = runs.filter(r => r.total.taxTrueUp.amount > 0.005);
  assert.ok(refunded.length > 0,
    'no fixture ends net-refunded, so nothing proves taxTrueUp needs to be bidirectional');
  console.log(`      net-refunded: ${refunded.map(r => `${r.name} (+${r.total.taxTrueUp.amount.toFixed(0)})`).join(', ')}`);
});

console.log(`\n${'─'.repeat(55)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(55)}\n`);
process.exit(failed > 0 ? 1 : 0);
