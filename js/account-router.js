/**
 * account-router.js
 *
 * Priority-based account lookup for crediting and debiting.
 * Routes funds to the best matching account by instrument type,
 * using expensable priority order (liquid/taxable first) when applicable.
 */

import { Currency } from './currency.js';
import { InstrumentType } from './instrument.js';

export class AccountRouter {

    constructor(modelAssets) {
        this.modelAssets = modelAssets;
    }

    creditToExpensable(amount, note = '') {
        return this.#applyToFirstMatch(InstrumentType.isExpensable, 'credit', amount, note);
    }

    debitFromExpensable(amount, note = '') {
        return this.#applyToFirstMatch(InstrumentType.isExpensable, 'debit', amount, note);
    }

    creditToTaxable(amount, note = '') {
        return this.#applyToFirstMatch(InstrumentType.isTaxableAccount, 'credit', amount, note);
    }

    debitFromTaxable(amount, note = '') {
        return this.#applyToFirstMatch(InstrumentType.isTaxableAccount, 'debit', amount, note);
    }

    getFirstExpensable() {
        for (const a of this.modelAssets) {
            if (InstrumentType.isExpensableAccount(a.instrument) && !a.isClosed) return a;
        }
        return null;
    }

    getFirstTaxable() {
        for (const a of this.modelAssets) {
            if (InstrumentType.isTaxableAccount(a.instrument) && !a.isClosed) return a;
        }
        return null;
    }

    #applyToFirstMatch(predicate, operation, amount, note) {
        if (predicate === InstrumentType.isExpensable) {
            for (const instrumentKey of InstrumentType.expensablePriority) {
                const match = this.modelAssets.find(
                    a => a.instrument === instrumentKey && !a.isClosed
                );
                if (match) return match[operation](amount, note);
            }
        } else {
            for (const a of this.modelAssets) {
                if (predicate(a.instrument) && !a.isClosed) {
                    return a[operation](amount, note);
                }
            }
        }
        return { assetChange: Currency.zero(), realizedGain: Currency.zero() };
    }
}
