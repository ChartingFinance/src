/**
 * <outcome-strip> — the answer to "will my money last?", on the first screen.
 *
 * Three tiles, one per way of asking: the plan as entered, the plan across
 * simulated markets, and the plan with spending guardrails. Each is labelled
 * with what it assumes, because they should differ. The numbers come from
 * outcome-summary.js, the same functions the simulation stat cards use.
 *
 * A simulation tile is dimmed while its result is from before the latest plan
 * change (the simulations re-run after every edit), and shows "Running…" until
 * its first result arrives.
 *
 * Properties:
 *   plan         planOutcome() result, or null
 *   simulations  simulationOutcome() result, or null
 *   guardrails   guardrailsOutcome() result, or null
 *   stale        { simulations: boolean, guardrails: boolean }
 *   finishAge    number
 *
 * Dispatches: 'outcome-jump' { detail: { section: 'timeline'|'simulations'|'guardrails' } }
 */

import { LitElement, html, nothing } from 'lit';

class OutcomeStrip extends LitElement {
    static properties = {
        plan:        { type: Object },
        simulations: { type: Object },
        guardrails:  { type: Object },
        stale:       { type: Object },
        finishAge:   { type: Number },
    };

    constructor() {
        super();
        this.plan = null;
        this.simulations = null;
        this.guardrails = null;
        this.stale = { simulations: false, guardrails: false };
        this.finishAge = null;
    }

    createRenderRoot() { return this; }

    _jump(section) {
        this.dispatchEvent(new CustomEvent('outcome-jump', { detail: { section }, bubbles: true }));
    }

    _tile(label, outcome, section, stale = false) {
        const tone = outcome?.tone ? ` tone-${outcome.tone}` : '';
        const dim = stale && outcome ? ' is-stale' : '';
        return html`
            <button type="button" class="outcome-tile${tone}${dim}"
                    title=${dim ? 'From before your latest change' : `Go to ${section}`}
                    @click=${() => this._jump(section)}>
                <span class="outcome-label">${label}</span>
                <span class="outcome-value">${outcome?.value ?? '…'}</span>
                <span class="outcome-detail">${outcome?.detail ?? 'Running…'}</span>
            </button>`;
    }

    render() {
        if (!this.plan) return nothing;
        const runs = this.simulations?.runs;
        return html`
            <div class="outcome-head">
                <h2 class="outcome-question">Will my money last?</h2>
                ${this.finishAge ? html`<span class="outcome-horizon">to age ${this.finishAge}</span>` : nothing}
            </div>
            <div class="outcome-tiles">
                ${this._tile('Plan as entered', this.plan, 'timeline')}
                ${this._tile(runs ? `In ${runs.toLocaleString()} simulated markets` : 'In simulated markets',
                             this.simulations, 'simulations', this.stale?.simulations)}
                ${this._tile('With spending guardrails', this.guardrails, 'guardrails', this.stale?.guardrails)}
            </div>`;
    }
}

customElements.define('outcome-strip', OutcomeStrip);
