Transition Plan: Vertically Stacked Analytical Layout
This document outlines the engineering tasks required to transition the UI from a standard tabbed dashboard to the professional, time-aligned vertical stack with discrete time selection and explicit controls.

Phase 1: Structural Layout Refactor
The first goal is to establish the rigid 8-col/4-col split and prepare the left side to act as a vertical flex container.

[ ] Lock the Main Grid: Ensure the parent container enforces the lg:col-span-8 (Left) and lg:col-span-4 (Right) layout regardless of internal content height.

[ ] Convert Left Panel to Flex-Col: Update the 8-column container to use a vertical flexbox or CSS Grid (display: flex; flex-direction: column; gap: 1rem;). This ensures that any injected components stack vertically and share the exact same width.

[ ] Align the Timeline Ledger: Move the <timeline-ledger> component inside the top of the 8-col container so its X-axis physically aligns with the charts that will render below it.

Phase 2: Additive View Toggles
Replace the mutually exclusive tab system with a toolbar that allows multiple views to be rendered simultaneously in the vertical stack.

[ ] Build the Toolbar Component: Create a new toggle bar (e.g., <projection-toolbar>) containing checkboxes or styled toggle buttons for: [ Macro Chart ], [ Micro Chart ], [ Snapshot Ledger ].

[ ] Implement Conditional Rendering: In the main view container, use Lit's html template to conditionally render components based on the toolbar's state.

[ ] Lock Chart Heights: Assign fixed or relative heights (e.g., height: 40vh) to the chart components so they don't collapse or expand infinitely when stacked. Chart.js requires stable parent containers with maintainAspectRatio: false.

Phase 3: Global Time State & The Master Picker
Establish the state management required to track the active time slice and provide precise selection tools directly within the timeline UI.

[ ] Define the Time State: In the parent component, create a reactive property to hold the currently selected time index (e.g., @state() selectedTimeIndex = null;). Initialize this state to represent the current year and month ("Today") upon component load.

[ ] Embed the Centered Time Picker: Add a precise calendar input (e.g., <input type="month"> or a custom Lit dropdown) directly inside the <timeline-ledger> component. Position it at the absolute top of the control, centered horizontally over the timeline.

[ ] Dispatch Selection Events: When a user explicitly changes the date via this centered picker, or clicks directly on the timeline canvas below it, dispatch a unified custom event (e.g., dispatch('time-select', { index: targetIndex })) to update the global selectedTimeIndex.

Phase 4: Synchronizing the Visual Crosshair & Timeline
Ensure the selected time index is clearly reflected across all macro and micro visual components, guiding the user's eye down the stack.

[ ] The "You Are Here" Dot: Update the <timeline-ledger> to reactively listen to selectedTimeIndex. Calculate the corresponding percentage along the X-axis and render an absolutely positioned SVG dot or badge resting directly on the timeline track to represent the active date.

[ ] Chart.js Annotation Plugin: Utilize chartjs-plugin-annotation to draw a subtle vertical shaded box (a "box annotation") over the selected year on both the Macro and Micro charts, providing the visual "plumb line" connecting the charts.

[ ] Programmatic Sync: When selectedTimeIndex changes, pass the new index down to all rendered charts to update the annotation plugin's X-scale coordinates and execute chart.update().

Phase 5: The Snapshot Panel (Bottom Layer)
Refactor the spreadsheet/report views to act as a dynamic snapshot that responds to the selected time index.

[ ] Create <snapshot-view>: Duplicate or refactor the existing <spreadsheet-view> into a specialized component that accepts selectedTimeIndex as a property.

[ ] Filter Data by Index: Instead of rendering the entire ledger, the <snapshot-view> should filter the projection arrays to only render the exact financial math for that specific month and year.

[ ] Native DOM Scrolling (Alternative): If retaining the full scrolling ledger is preferred, use native DOM APIs (rowElement.scrollIntoView({ behavior: 'smooth', block: 'center' })) to automatically slide the targeted time row into the center of the viewport when selectedTimeIndex updates.

Phase 6: Portfolio Panel Binding (Right Side)
Connect the interactive 4-col control surface to the newly stacked charts.

[ ] Highlighting Logic: Retain the logic where hovering an <asset-card> in the right panel dispatches a selection event.

[ ] Multi-Chart Response: Ensure the parent container passes the highlighted asset ID to both the Macro and Micro charts.

Micro chart: Highlights the specific asset line.

Macro chart: Highlights the parent group's stacked area.