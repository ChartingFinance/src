/**
 * plan-diff.js — what changed, and what it did.
 *
 * ── Why this is a tool and not a paragraph ───────────────────────────
 *
 * Ask #5 of the round-trip notes: once a plan can go out to the browser and
 * come back, the very next question is "what did they change, and what did it
 * do?" Answering it by re-reading two full reports and eyeballing them is how
 * the two bugs in those notes stayed invisible — the ages differed by fifteen
 * years across two documents and nobody saw it, because nothing put the two
 * numbers next to each other.
 *
 * So the comparison is mechanical. Every field is compared; the ones that moved
 * are listed. Nothing is summarised away, and there is no threshold below which
 * a difference is deemed uninteresting — that judgement is exactly what missed
 * a fifteen-year age gap.
 *
 * ── Two halves, deliberately separated ───────────────────────────────
 *
 * `diffSpecs` compares the PLANS: settings, assets, life events. It is pure and
 * runs nothing, so it answers "what did they change?" for free.
 *
 * `diffOutcomes` compares what the engine DID with them, and needs both runs.
 * Keeping them apart matters because the interesting failure is a large outcome
 * difference with an empty spec difference — two runs of the same plan should
 * be identical, and if they are not, the engine is not deterministic. The
 * renderer says so out loud rather than presenting it as a finding about money.
 *
 * ── Assets are keyed by displayName ──────────────────────────────────
 *
 * Which is the repository's known latent foreign-key problem, and it shows here
 * as its most honest symptom: renaming an asset reads as one deletion and one
 * addition. That is not wrong — this cannot tell a rename from a swap — and it
 * is better than silently pairing two assets that are not the same account. It
 * gets better when stableId lands, and not before.
 */

const SETTING_LABELS = {
    startAge:       'Start age',
    retirementAge:  'Retirement age',
    finishAge:      'Finish age',
    filingAs:       'Filing status',
    inflationRate:  'Inflation',
};

const fmtSetting = (key, v) => {
    if (v == null) return '—';
    if (key === 'inflationRate') return `${(v * 100).toFixed(1)}%`;
    return String(v);
};

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Assets by display name. See the header: a rename reads as remove + add. */
function byName(assets) {
    const m = new Map();
    for (const a of assets ?? []) m.set(a.displayName ?? '(unnamed)', a);
    return m;
}

/**
 * The plans, compared. Pure — runs nothing.
 *
 * @returns {{settings: Array, assets: {added,removed,changed}, lifeEvents: object,
 *            identical: boolean}}
 */
export function diffSpecs(a, b) {
    const settings = [];
    const sa = a?.settings ?? {}, sb = b?.settings ?? {};
    for (const key of Object.keys(SETTING_LABELS)) {
        if (!same(sa[key], sb[key])) {
            settings.push({ key, label: SETTING_LABELS[key], from: sa[key], to: sb[key] });
        }
    }
    // Anything the app grows later shows up here rather than being dropped
    // because this file has not heard of it yet.
    for (const key of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
        if (key in SETTING_LABELS) continue;
        if (!same(sa[key], sb[key])) settings.push({ key, label: key, from: sa[key], to: sb[key] });
    }

    const ma = byName(a?.modelAssets), mb = byName(b?.modelAssets);
    const added = [...mb.keys()].filter(n => !ma.has(n));
    const removed = [...ma.keys()].filter(n => !mb.has(n));
    const changed = [];
    for (const [name, assetA] of ma) {
        const assetB = mb.get(name);
        if (!assetB) continue;
        const fields = [];
        for (const key of new Set([...Object.keys(assetA), ...Object.keys(assetB)])) {
            if (!same(assetA[key], assetB[key])) {
                fields.push({ key, from: assetA[key], to: assetB[key] });
            }
        }
        if (fields.length) changed.push({ name, fields });
    }

    const la = a?.lifeEvents ?? [], lb = b?.lifeEvents ?? [];
    const lifeEvents = { countFrom: la.length, countTo: lb.length, changed: !same(la, lb) };

    const identical = settings.length === 0 && !added.length && !removed.length
        && !changed.length && !lifeEvents.changed && same(a?.name, b?.name);

    return { settings, assets: { added, removed, changed }, lifeEvents, identical };
}

/** Headline figures from two completed runs. */
export function diffOutcomes(runA, runB) {
    const of = (run) => ({
        endingNetWorth: run.portfolio.finishValue?.().amount ?? null,
        lifetimeTax:    Math.abs(run.portfolio.total?.totalTaxes?.().amount ?? 0),
        issues:         run.issues.filter(i => i.category === 'obligation').length,
        findings:       run.issues.length,
    });
    const a = of(runA), b = of(runB);
    return {
        rows: [
            { label: 'Ending net worth', from: a.endingNetWorth, to: b.endingNetWorth, money: true },
            { label: 'Lifetime tax',     from: a.lifetimeTax,    to: b.lifetimeTax,    money: true },
            { label: 'Unpayable obligations', from: a.issues,    to: b.issues,         money: false },
            { label: 'Findings, all categories', from: a.findings, to: b.findings,     money: false },
        ],
    };
}

const money = (n) => (n == null ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n));

function deltaCell(from, to, isMoney) {
    if (from == null || to == null) return '—';
    const d = to - from;
    if (d === 0) return 'unchanged';
    const sign = d > 0 ? '+' : '−';
    const mag = isMoney ? money(Math.abs(d)) : String(Math.abs(d));
    const pct = (isMoney && from !== 0) ? ` (${sign}${Math.abs(d / from * 100).toFixed(1)}%)` : '';
    return `${sign}${mag}${pct}`;
}

/** A short, honest rendering of a value inside an asset field. */
function fieldValue(v) {
    if (v == null) return '—';
    if (typeof v === 'object') {
        if ('amount' in v) return money(v.amount);
        if ('rate' in v) return `${(v.rate * 100).toFixed(2)}%`;
        if ('year' in v && 'month' in v) return `${v.year}-${String(v.month).padStart(2, '0')}`;
        const s = JSON.stringify(v);
        return s.length > 60 ? s.slice(0, 57) + '…' : s;
    }
    return String(v);
}

export function diffMarkdown({ handleA, handleB, spec, outcome }) {
    let md = `# Plan diff\n\n`;
    md += `**A:** \`${handleA}\`  →  **B:** \`${handleB}\`\n\n`;

    if (handleA === handleB) {
        // Same content address means the same plan, field for field. Saying so
        // is the useful answer, and it is also the round-trip check: a plan sent
        // to the browser and read back unchanged lands exactly here.
        md += `These are the same plan — identical content address, so nothing was changed.\n`;
        return md;
    }

    md += `## What changed in the plan\n\n`;
    if (spec.identical) {
        md += `Nothing. The two specs are field-for-field identical but hash differently, `
            + `which should not happen — treat it as a bug in the handle, not a finding `
            + `about the plans.\n\n`;
    } else {
        if (spec.settings.length) {
            md += `### Settings\n\n| | A | B |\n| :--- | ---: | ---: |\n`;
            for (const s of spec.settings) {
                md += `| ${s.label} | ${fmtSetting(s.key, s.from)} | ${fmtSetting(s.key, s.to)} |\n`;
            }
            md += '\n';
        }
        const { added, removed, changed } = spec.assets;
        if (added.length)   md += `### Added\n\n${added.map(n => `- ${n}`).join('\n')}\n\n`;
        if (removed.length) md += `### Removed\n\n${removed.map(n => `- ${n}`).join('\n')}\n\n`;
        if (changed.length) {
            md += `### Changed\n\n| Asset | Field | A | B |\n| :--- | :--- | ---: | ---: |\n`;
            for (const c of changed) {
                for (const f of c.fields) {
                    md += `| ${c.name} | ${f.key} | ${fieldValue(f.from)} | ${fieldValue(f.to)} |\n`;
                }
            }
            md += '\n';
        }
        if (spec.lifeEvents.changed) {
            md += `### Life events\n\nChanged — ${spec.lifeEvents.countFrom} in A, `
                + `${spec.lifeEvents.countTo} in B. Phase boundaries move what the engine does `
                + `in every month after them, so expect the outcome table below to move too.\n\n`;
        }
        if (removed.length && added.length) {
            md += `> An asset renamed between the two plans appears above as one removal and one `
                + `addition: plans are compared by display name, which cannot tell a rename from `
                + `a swap.\n\n`;
        }
    }

    md += `## What it did to the numbers\n\n`;
    md += `| | A | B | Change |\n| :--- | ---: | ---: | ---: |\n`;
    for (const r of outcome.rows) {
        const fmt = r.money ? money : (v) => String(v ?? '—');
        md += `| ${r.label} | ${fmt(r.from)} | ${fmt(r.to)} | ${deltaCell(r.from, r.to, r.money)} |\n`;
    }
    md += '\n';

    if (spec.identical) {
        md += `> The plans are identical and the outcomes are shown anyway: if any row above `
            + `moved, the engine is not deterministic, which is a much larger finding than `
            + `anything about these two plans.\n\n`;
    }

    md += `Ask \`explain_month\` against either handle for why a particular month differs. `
        + `A diff says what moved; only the recorded events say why.\n`;
    return md;
}
