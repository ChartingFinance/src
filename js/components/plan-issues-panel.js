/**
 * <plan-issues-panel>
 *
 * What needs attention in the plan (not <issues-modal>, the "report a bug"
 * form). Findings come from portfolio-issues.js; this file only shows them.
 *
 *   It opens itself once, when the plan goes from nothing wrong to something
 *   wrong — calculate() runs on every edit, and reopening each time would
 *   fight the user. After that the badge is the reminder.
 *
 *   The month the plan runs out of money gets its own callout above the list.
 *
 * Properties:
 *   issues     - Issue[] from detectIssues()
 *   open       - boolean
 *
 * Dispatches: 'toggle' when the user opens or closes it
 */

import { LitElement, html, nothing } from 'lit';
import { planExhaustion, monthLabel } from '../portfolio-issues.js';

// Labels have to cover both severities in a category. "Could not be paid" was
// the first attempt and it sat above a notice reading "the obligations were
// met" — a heading that contradicts the row under it reads as a bug in the
// tool. The category says what the finding is ABOUT; severity says how bad.
const CATEGORY_META = {
    obligation:     { label: 'Paying for the plan',  emoji: '\u{1F4B8}' },
    configuration:  { label: 'Needs setting up',     emoji: '\u{1F527}' },
    reconciliation: { label: 'Engine diagnostics',   emoji: '\u{1F9EA}' },
};

const CATEGORY_ORDER = ['obligation', 'configuration', 'reconciliation'];

class PlanIssuesPanel extends LitElement {

    static properties = {
        issues: { type: Array },
        open:   { type: Boolean, reflect: true },
    };

    createRenderRoot() { return this; }

    constructor() {
        super();
        this.issues = [];
        this.open = false;
        /** Guards the once-only auto-open. */
        this._wasClear = true;
    }

    updated(changed) {
        if (!changed.has('issues')) return;

        const clear = (this.issues?.length ?? 0) === 0;
        // Only the 0 -> n edge opens the panel. Going from three issues to
        // four while someone edits an asset must not steal their focus.
        if (this._wasClear && !clear) this.open = true;
        if (clear) this.open = false;
        this._wasClear = clear;
    }

    _toggle() {
        this.open = !this.open;
        this.dispatchEvent(new CustomEvent('toggle', {
            bubbles: true, composed: true, detail: { open: this.open },
        }));
    }

    /** Grouped for display, in a fixed order so the panel does not reshuffle. */
    get _grouped() {
        const out = [];
        for (const key of CATEGORY_ORDER) {
            const list = (this.issues ?? []).filter(i => i.category === key && i.id !== 'plan-exhaustion');
            if (list.length) out.push([key, list]);
        }
        return out;
    }

    render() {
        const issues = this.issues ?? [];
        if (issues.length === 0) return nothing;

        const exhaustion = planExhaustion(issues);

        return html`
            <div class="plan-issues ${this.open ? 'is-open' : ''}">
                <button class="plan-issues-toggle" @click=${this._toggle}
                        aria-expanded=${this.open ? 'true' : 'false'}>
                    <span class="plan-issues-caret">${this.open ? '▾' : '▸'}</span>
                    <span>What needs attention</span>
                    <span class="plan-issues-count">${issues.length}</span>
                </button>

                ${this.open ? html`
                    <div class="plan-issues-body">
                        ${exhaustion ? html`
                            <div class="plan-issues-headline">
                                <div class="plan-issues-headline-title">
                                    ${exhaustion.headline}
                                </div>
                                <div class="plan-issues-headline-detail">${exhaustion.detail}</div>
                            </div>
                        ` : nothing}

                        ${this._grouped.map(([key, list]) => html`
                            <div class="plan-issues-group">
                                <div class="plan-issues-group-label">
                                    ${CATEGORY_META[key].emoji} ${CATEGORY_META[key].label}
                                </div>
                                ${list.map(i => this._renderIssue(i))}
                            </div>
                        `)}
                    </div>
                ` : nothing}
            </div>
        `;
    }

    _renderIssue(issue) {
        return html`
            <div class="plan-issue plan-issue-${issue.severity}">
                <div class="plan-issue-head">
                    ${issue.assetName
                        ? html`<span class="plan-issue-asset">${issue.assetName}</span>`
                        : nothing}
                    <span class="plan-issue-headline">${issue.headline}</span>
                    ${issue.firstDateInt && issue.id !== 'funding-ran-dry'
                        ? html`<span class="plan-issue-when">${monthLabel(issue.firstDateInt)}</span>`
                        : nothing}
                </div>
                <div class="plan-issue-detail">${issue.detail}</div>
                ${issue.reasons?.length ? html`
                    <div class="plan-issue-why">${issue.reasons.join(' · ')}</div>
                ` : nothing}
            </div>
        `;
    }
}

customElements.define('plan-issues-panel', PlanIssuesPanel);
