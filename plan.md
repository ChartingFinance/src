# Properties View — Instrument-Based Classification

## Summary
Replace data-driven property group classification with static instrument-based sets. Update taxonomy to 11 groups including All, Capital, Real Estate, Savings, Growth, and Cash Flow. All groups start collapsed.

## Final Taxonomy

| Group | Instruments | Rollup Metric | Notes |
|---|---|---|---|
| All | All instruments (alpha sorted) | VALUE | Show everything |
| Capital | REAL_ESTATE, TAXABLE_EQUITY | VALUE, GROWTH | Appreciating assets with basis |
| Real Estate | REAL_ESTATE, MORTGAGE | VALUE | Mirrors existing asset group |
| Income | WORKING_INCOME, RETIREMENT_INCOME, TAXABLE_EQUITY, BANK, US_BOND, CORP_BOND | INCOME/DIVIDEND/INTEREST_INCOME | Assets that generate income |
| Tax | WORKING_INCOME, REAL_ESTATE, TAXABLE_EQUITY, FOUR_01K, IRA | Tax metrics | Assets with tax consequences |
| Savings | BANK, US_BOND, CORP_BOND | VALUE | Fixed-income/savings vehicles |
| Expenses | MONTHLY_EXPENSE, REAL_ESTATE, DEBT | EXPENSE | Outflows (RE: maintenance+insurance future) |
| Retirement | FOUR_01K, IRA, ROTH_IRA | VALUE + contribution/distribution/RMD | Tax-advantaged retirement accounts |
| Debt Service | MORTGAGE, DEBT | MORTGAGE_PAYMENT | Loan payments |
| Cash Flow | (no instruments) | CASH_FLOW | Group-level metric only, all assets in Micro chart |
| Growth | (no instruments) | GROWTH | Group-level metric only, all assets in Micro chart |

## Steps

### Step 1: Update `property-groups.js`
- Replace `PropertyGroup` enum with 11 groups
- Replace `PropertyGroupMetrics` with instrument-based Sets (like asset-groups.js pattern)
- New `classifyAssetsByProperty(modelAssets)` — uses Set membership, not metric history scanning
- Remove `_assetHasNonZeroMetrics` function
- Update `PropertyGroupMeta` with colors/emojis for new groups
- Update `PROPERTY_DISPLAY_ORDER`
- Update `getPrimaryMetric` to use instrument→metric mapping instead of history scanning
- Handle Cash Flow and Growth as special asset-less groups (similar to Taxes group in assets view)
- `sumPropertyDisplayHistories` — handle Cash Flow/Growth by summing across all assets

### Step 2: Update `asset-list.js`
- `_renderPropertiesView()` — handle Cash Flow and Growth as special groups (no child assets, just rollup in header)
- For Cash Flow and Growth Micro chart expansion: show all assets
- Ensure all groups start collapsed (no default expanded groups)

### Step 3: Update `finplan-app.js`
- Ensure expandedGroups starts empty (all collapsed) on data load
- Wire Micro chart to show all assets when Cash Flow or Growth group is expanded
- Metric dropdown filtering: when Properties view is active and a group is expanded, filter dropdown to that group's relevant metrics

### Step 4: Update Macro chart integration
- When viewMode is 'properties', build chart datasets from property groups instead of asset groups
- Cash Flow and Growth groups get their own chart datasets using respective metrics summed across all assets
