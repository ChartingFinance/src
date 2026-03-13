# 📈 Charting Finance: Portfolio Projection Report

## 🌍 Global Parameters & Context
* **Simulation Period:** {startDate} to {finishDate} ({totalMonths} months)
* **User Lifecycle:** Start Age {startAge} → Retirement Age {retirementAge} → Finish Age {finishAge}
* **Tax Profile:** {filingAs}, Tax Year {taxYear}
* **Macro Assumptions:** {inflationRate}% Annual Inflation

---

## 📊 Top-Line Ledger (The "TL;DR")
| Core Metric | Starting Snapshot | Finishing Snapshot | CAGR / Total Flow |
| :--- | :--- | :--- | :--- |
| **Total Net Worth** | ${startValue} | ${finishValue} | {cagr}% |
| **Accumulated Income** | - | ${totalIncome} | N/A |
| **Accumulated Expenses**| - | ${totalExpenses} | N/A |
| **Total Taxes Paid** | - | ${totalTaxes} | (Effective Rate: {effRate}%) |

---

## 💼 Asset Configuration & Performance Stack

*(Note for AI: Assets are listed below. Pay special attention to the `[Transfers]` which indicate how cash flows between instruments).*

### 🔧 {Asset.displayName} ({Instrument.WORKING_INCOME})
* **Timeline:** {startDate} to {finishDate}
* **Income Rate:** ${startCurrency}/mo (Self-Employed: {isSelfEmployed})
* **[Transfers / Piping]:** * ↳ {frequency} {amount/percent} to `{targetAsset1}` (Pre-tax)
  * ↳ {frequency} {amount/percent} to `{targetAsset2}` (Post-tax)
* **Terminal Rollup:** ${totalNetIncome} Total Net Income Generated, ${totalFICA} FICA Paid.

### 🏡 {Asset.displayName} ({Instrument.REAL_ESTATE})
* **Timeline:** {startDate} to {finishDate}
* **Valuation:** Start ${startCurrency} → Finish ${finishCurrency} (ARR: {annualReturnRate}%)
* **Tax Profile:** Property Tax {annualTaxRate}%, Primary Residence: {isPrimaryHome}
* **Terminal Rollup:** ${totalPropertyTaxPaid} Total Taxes Paid, ${totalGrowth} Total Appreciation.

### 💳 {Asset.displayName} ({Instrument.MORTGAGE})
* **Timeline:** {monthsRemaining} Months Remaining
* **Valuation:** Starting Balance ${startCurrency} → Finish Balance ${finishCurrency}
* **Loan Details:** {annualReturnRate}% Interest Rate
* **Terminal Rollup:** ${totalPrincipalPaid} Principal Paid, ${totalInterestPaid} Interest Paid.

### ⏳ {Asset.displayName} ({Instrument.FOUR_01K} / {Instrument.IRA})
* **Timeline:** {startDate} to {finishDate}
* **Valuation:** Start ${startCurrency} → Finish ${finishCurrency} (ARR: {annualReturnRate}%)
* **Terminal Rollup:** * Total Contributions: ${totalContributions}
  * Total Distributions: ${totalDistributions}
  * Total RMDs Forced: ${totalRMDs}

### 🧾 {Asset.displayName} ({Instrument.TAXABLE_EQUITY})
* **Timeline:** {startDate} to {finishDate}
* **Valuation:** Start ${startCurrency} (Basis: ${startBasis}) → Finish ${finishCurrency} (Basis: ${finishBasis})
* **Rates:** ARR {annualReturnRate}%, Dividend Yield {dividendRate}%, LT Cap Gains Holding {longTermRate}%
* **[Transfers / Piping]:**
  * ↳ On Close: Transfer 100% to `{liquidCheckingAccount}`
* **Terminal Rollup:** ${totalDividends} Dividends, ${totalCapitalGains} Cap Gains, ${estimatedTaxes} Estimated Taxes.

---

## 🚦 System Warnings & Guardrails (If Applicable)
* **Guyton-Klinger Guardrails:** {Triggered 3 times: Spending reduced by 10% in 2032, 2038}
* **Shortfalls:** {e.g., Checking Account hit $0 in 2041, triggering gross-up withdrawals from Taxable Equity}