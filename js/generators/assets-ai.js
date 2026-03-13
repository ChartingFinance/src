/**
 * assets-ai.js
 *
 * Generates a self-contained Markdown report from a completed Portfolio,
 * designed for consumption by AI systems with no prior project knowledge.
 */

import { InstrumentType, InstrumentMeta } from '../instruments/instrument.js';
import {
    global_user_startAge, global_user_retirementAge, global_user_finishAge,
    global_filingAs, global_taxYear, global_inflationRate,
} from '../globals.js';

const fmt = (val) =>
    new Intl.NumberFormat('en-US', {
        style: 'currency', currency: 'USD', maximumFractionDigits: 0,
    }).format(val || 0);

const pct = (val, decimals = 1) => (val * 100).toFixed(decimals) + '%';

/**
 * @param {Portfolio} portfolio - A portfolio that has already been through chronometer_run()
 * @returns {string} Markdown report
 */
export function generatePortfolioMarkdown(portfolio) {
    const assets = portfolio.modelAssets;
    const total = portfolio.total;
    const startDate = portfolio.firstDateInt;
    const endDate = portfolio.lastDateInt;

    // Calculate total months
    const totalMonths = (endDate.year - startDate.year) * 12 + (endDate.month - startDate.month);

    // Net worth
    const startNW = portfolio.startValue().amount;
    const endNW = portfolio.finishValue().amount;

    // CAGR
    const years = totalMonths / 12;
    const cagr = startNW > 0 && endNW > 0
        ? ((Math.pow(endNW / startNW, 1 / years) - 1) * 100).toFixed(1)
        : 'N/A';

    let md = '';

    // ── Header ──────────────────────────────────────────────────
    md += `# Portfolio Projection Report\n\n`;

    md += `## Simulation Parameters\n`;
    md += `| Parameter | Value |\n`;
    md += `| :--- | :--- |\n`;
    md += `| Simulation Period | ${startDate.toString()} to ${endDate.toString()} (${totalMonths} months) |\n`;
    md += `| Lifecycle | Age ${global_user_startAge} start, ${global_user_retirementAge} retirement, ${global_user_finishAge} finish |\n`;
    md += `| Filing Status | ${global_filingAs} |\n`;
    md += `| Tax Year Basis | ${global_taxYear} |\n`;
    md += `| Inflation Assumption | ${pct(global_inflationRate)} |\n\n`;

    // ── Top-Line Summary ────────────────────────────────────────
    const totalIncome = total.totalIncome().amount;
    const totalExpenses = Math.abs(total.expense.amount);
    const totalTaxes = Math.abs(total.totalTaxes().amount);
    const effRate = totalIncome > 0 ? ((totalTaxes / totalIncome) * 100).toFixed(1) : '0.0';

    md += `## Net Worth Summary\n`;
    md += `| Metric | Value |\n`;
    md += `| :--- | :--- |\n`;
    md += `| Starting Net Worth | ${fmt(startNW)} |\n`;
    md += `| Ending Net Worth | ${fmt(endNW)} |\n`;
    md += `| CAGR | ${cagr}% |\n`;
    md += `| Accumulated Income | ${fmt(totalIncome)} |\n`;
    md += `| Accumulated Expenses | ${fmt(totalExpenses)} |\n`;
    md += `| Total Taxes Paid | ${fmt(totalTaxes)} (effective rate: ${effRate}%) |\n\n`;

    // ── Annual Cash Flow ────────────────────────────────────────
    const yearlyReports = portfolio.generatedReports.filter(r => r.type === 'yearly');
    if (yearlyReports.length > 0) {
        md += `## Annual Cash Flow\n`;
        md += `| Year | Gross Income | Taxes | Contributions | Expenses | Mortgage P+I | Cash Surplus | Growth |\n`;
        md += `| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`;

        for (const report of yearlyReports) {
            const p = report.pkg;
            const income = p.totalIncome().amount;
            const taxes = Math.abs(p.totalTaxes().amount);
            const contribs = Math.abs(p.contributions().amount);
            const expenses = Math.abs(p.expense.amount);
            const mortgage = Math.abs(p.mortgageInterest.amount) + Math.abs(p.mortgagePrincipal.amount);
            const surplus = income - taxes - contribs - expenses - mortgage;
            const growth = p.growth().amount;

            md += `| ${report.dateLabel} | ${fmt(income)} | ${fmt(taxes)} | ${fmt(contribs)} | ${fmt(expenses)} | ${fmt(mortgage)} | ${fmt(surplus)} | ${fmt(growth)} |\n`;
        }
        md += '\n';
    }

    // ── Asset Inventory ─────────────────────────────────────────
    md += `## Asset Inventory\n\n`;

    for (const asset of assets) {
        const meta = InstrumentMeta.get(asset.instrument);
        const emoji = meta?.emoji || '';
        const typeLabel = meta?.label || asset.instrument;
        const isIncome = InstrumentType.isMonthlyIncome(asset.instrument);
        const isExpense = InstrumentType.isMonthlyExpense(asset.instrument);
        const isMortgage = InstrumentType.isMortgage(asset.instrument);
        const isDebt = InstrumentType.isDebt(asset.instrument);

        md += `### ${emoji} ${asset.displayName} (${typeLabel})\n`;
        md += `- Timeline: ${asset.startDateInt.toString()} to ${asset.finishDateInt.toString()}`;
        if (asset.isClosed) md += ` (closed)`;
        md += `\n`;

        if (isIncome) {
            md += `- Monthly Amount: ${fmt(asset.startCurrency.amount)}/mo\n`;
            md += `- Annual Raise: ${pct(asset.annualReturnRate.rate)}\n`;
        } else if (isExpense) {
            md += `- Monthly Amount: ${fmt(Math.abs(asset.startCurrency.amount))}/mo\n`;
            md += `- Annual Inflation: ${pct(asset.annualReturnRate.rate)}\n`;
        } else if (isMortgage) {
            md += `- Original Balance: ${fmt(Math.abs(asset.startCurrency.amount))}\n`;
            md += `- Current Balance: ${fmt(Math.abs(asset.finishCurrency.amount))}\n`;
            md += `- Interest Rate: ${pct(asset.annualReturnRate.rate)}\n`;
        } else if (isDebt) {
            md += `- Balance: ${fmt(Math.abs(asset.startCurrency.amount))} start, ${fmt(Math.abs(asset.finishCurrency.amount))} end\n`;
            md += `- Interest Rate: ${pct(asset.annualReturnRate.rate)}\n`;
        } else {
            md += `- Valuation: ${fmt(asset.startCurrency.amount)} start, ${fmt(asset.finishCurrency.amount)} end\n`;
            md += `- Annual Return: ${pct(asset.annualReturnRate.rate)}\n`;
            if (asset.startBasisCurrency.amount > 0) {
                md += `- Cost Basis: ${fmt(asset.startBasisCurrency.amount)} start, ${fmt(asset.finishBasisCurrency.amount)} end\n`;
            }
        }

        // Tax classification
        if (InstrumentType.isTaxDeferred(asset.instrument)) md += `- Tax Status: Tax-Deferred (distributions taxed as ordinary income)\n`;
        else if (InstrumentType.isTaxFree(asset.instrument)) md += `- Tax Status: Tax-Free (qualified distributions not taxed)\n`;
        else if (InstrumentType.isTaxableAccount(asset.instrument)) md += `- Tax Status: Taxable (capital gains on sale)\n`;

        // Property tax
        if (asset.annualTaxRate && asset.annualTaxRate.rate > 0) {
            md += `- Property Tax Rate: ${pct(asset.annualTaxRate.rate)}\n`;
        }

        // Fund transfers
        if (asset.fundTransfers?.length > 0) {
            md += `- Fund Transfers:\n`;
            for (const ft of asset.fundTransfers) {
                const parts = [];
                if (ft.monthlyMoveValue > 0) parts.push(`${ft.monthlyMoveValue}% monthly`);
                if (ft.closeMoveValue > 0) parts.push(`${ft.closeMoveValue}% on close`);
                md += `  - ${parts.join(', ')} to ${ft.toDisplayName}\n`;
            }
        }

        md += '\n';
    }

    // ── Money Flow Topology ─────────────────────────────────────
    md += `## Money Flow Topology\n`;
    md += `*(How cash moves between accounts each month)*\n\n`;
    md += '```\n';

    for (const asset of assets) {
        if (!asset.fundTransfers?.length) continue;
        for (const ft of asset.fundTransfers) {
            const parts = [];
            if (ft.monthlyMoveValue > 0) parts.push(`${ft.monthlyMoveValue}% monthly`);
            if (ft.closeMoveValue > 0) parts.push(`${ft.closeMoveValue}% on close`);
            md += `${asset.displayName} --> [${parts.join(', ')}] --> ${ft.toDisplayName}\n`;
        }
    }

    md += '```\n\n';

    // ── Tax Breakdown ───────────────────────────────────────────
    md += `## Lifetime Tax Breakdown\n`;
    md += `| Tax Category | Amount |\n`;
    md += `| :--- | ---: |\n`;
    md += `| Federal Income Tax | ${fmt(Math.abs(total.incomeTax.amount))} |\n`;
    md += `| Social Security Tax | ${fmt(Math.abs(total.socialSecurityTax.amount))} |\n`;
    md += `| Medicare Tax | ${fmt(Math.abs(total.medicareTax.amount))} |\n`;
    md += `| Long-Term Capital Gains Tax | ${fmt(Math.abs(total.longTermCapitalGainsTax.amount))} |\n`;
    md += `| Property Taxes | ${fmt(Math.abs(total.propertyTaxes.amount))} |\n`;
    md += `| Estimated Taxes (gross-up) | ${fmt(Math.abs(total.estimatedTaxes.amount))} |\n`;
    md += `| **Total** | **${fmt(Math.abs(total.totalTaxes().amount))}** |\n\n`;

    // ── Observations ────────────────────────────────────────────
    const observations = [];

    // Negative brokerage
    for (const asset of assets) {
        if (InstrumentType.isTaxableAccount(asset.instrument) && asset.finishCurrency.amount < 0) {
            observations.push(`${asset.displayName} ended with a negative balance (${fmt(asset.finishCurrency.amount)}), indicating expenses exceeded available liquid assets.`);
        }
    }

    // Net worth direction
    if (endNW < startNW) {
        observations.push(`Net worth declined from ${fmt(startNW)} to ${fmt(endNW)} over the simulation period.`);
    }

    // Effective tax rate
    if (parseFloat(effRate) > 30) {
        observations.push(`Effective tax rate is ${effRate}%, which is above typical thresholds and may warrant tax optimization strategies.`);
    }

    // Social security income present
    if (total.socialSecurityIncome.amount > 0) {
        observations.push(`Social Security benefits totaling ${fmt(total.socialSecurityIncome.amount)} were received during the simulation.`);
    }

    if (observations.length > 0) {
        md += `## Observations\n`;
        for (const obs of observations) {
            md += `- ${obs}\n`;
        }
        md += '\n';
    }

    md += `---\n*Generated by https://Charting.Finance/ portfolio simulator*\n`;

    return md;
}
