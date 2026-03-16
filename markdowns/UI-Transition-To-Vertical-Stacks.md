Transition Plan: Vertically Stacked Analytical Layout
This document outlines the engineering tasks required to transition the UI from a standard tabbed dashboard to the professional, time-aligned vertical stack with a synchronized scrubber.

Phase 1: Structural Layout Refactor
The first goal is to establish the rigid 8-col/4-col split and prepare the left side to act as a vertical flex container.

[ ] Lock the Main Grid: Ensure the parent container enforces the lg:col-span-8 (Left) and lg:col-span-4 (Right) layout regardless of internal content height.

[ ] Convert Left Panel to Flex-Col: Update the 8-column container to use a vertical flexbox or CSS Grid (display: flex; flex-direction: column; gap: 1rem;). This ensures that any injected components stack vertically and share the exact same width.

[ ] Align the Timeline Ledger: Move the <timeline-ledger> component inside the top of the 8-col container so its X-axis physically aligns with the charts that will render below it.

Phase 2: Additive View Toggles
Replace the mutually exclusive tab system with a toolbar that allows multiple views to be rendered simultaneously in the vertical stack.

[ ] Build the Toolbar Component: Create a new toggle bar (e.g., <projection-toolbar>) containing checkboxes or styled toggle buttons for: [ Macro Chart ], [ Micro Chart ], [ Snapshot Ledger ].

[ ] Implement Conditional Rendering: In the main view container, use Lit's html template to conditionally render components based on the toolbar's state.

JavaScript
// Pseudo-implementation
${this.showMacro ? html`<macro-chart-view .data=${this.data}></macro-chart-view>` : ''}
${this.showMicro ? html`<micro-chart-view .data=${this.data}></micro-chart-view>` : ''}
[ ] Lock Chart Heights: Assign fixed or relative heights (e.g., height: 40vh) to the chart components so they don't collapse or expand infinitely when stacked. Chart.js requires stable parent containers with maintainAspectRatio: false.

Phase 3: Global Time State & The Scrubber
Establish the state management required to track the user's cursor across the X-axis.

[ ] Define the Scrubber State: In the parent component (or context provider), create a reactive property to hold the currently hovered time index (e.g., @state() activeTimeIndex = null;).

[ ] Chart.js Hover Events: Attach an onHover event listener to both Chart.js instances. When the user moves the mouse over the canvas, calculate the closest data point on the X-axis and dispatch a custom Lit event (e.g., dispatch('time-scrub', { index: hoveredIndex })).

[ ] Sync State Upwards: The parent container listens for time-scrub from any chart and updates its activeTimeIndex.

Phase 4: Synchronizing the Visual Crosshair
Ensure that hovering over one chart visually updates the other chart to maintain the "plumb line" effect.

[ ] Chart.js Crosshair Plugin: Implement a custom Chart.js plugin (or use an existing one like chartjs-plugin-crosshair) to draw a vertical line at the active X-axis coordinate.

[ ] Programmatic Tooltips/Active Elements: When activeTimeIndex changes in the parent, pass it down to all rendered charts. Use Chart.js API chart.setActiveElements([{ datasetIndex: ..., index: activeTimeIndex }]) followed by chart.tooltip.setActiveElements(...) and chart.update(). This forces the inactive chart to highlight the same month/year the user is hovering over on the active chart.

Phase 5: The Snapshot Panel (Bottom Layer)
Refactor the spreadsheet/report views to act as a dynamic snapshot rather than a massive scrolling grid.

[ ] Create <snapshot-view>: Duplicate or refactor the existing <spreadsheet-view> into a specialized component that accepts activeTimeIndex as a property.

[ ] Filter Data by Index: Instead of rendering the entire 40-year ledger, the <snapshot-view> should filter the projection arrays to only render the math for that specific index.

[ ] Format for Density: Style the snapshot panel to look like a high-density summary (e.g., a multi-column mini-table showing exact values for Income, Real Estate, Capital, and Taxes for that specific month).

[ ] Fallback State: If activeTimeIndex is null (mouse is off the charts), the snapshot panel should either display the starting year data, the ending year data, or a subtle placeholder stating "Hover over timeline to view data."

Phase 6: Portfolio Panel Binding (Right Side)
Connect the interactive 4-col control surface to the newly stacked charts.

[ ] Highlighting Logic: Retain the logic where hovering an <asset-card> in the right panel dispatches an event.

[ ] Multi-Chart Response: Ensure the parent container passes the highlighted asset ID to both the Macro and Micro charts.

Micro chart: Highlights the specific asset line.

Macro chart: Highlights the parent group's stacked area.