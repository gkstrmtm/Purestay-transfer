# Exhibit Component Resolution Prompt

Use this prompt to drive the API toward precise component recommendations for the current portal.

## Objective

Resolve this product as an internal operations workbench and return the best-fit component system for a dense company portal. The goal is not broad design discovery. The goal is precise component resolution for implementation.

This surface should be treated as a serious internal company system used for repeat operational work. It should bias toward compact, utility-first components and avoid decorative or marketing-oriented output.

## Use This Only After Route And Shell Are Settled

This prompt should not be the first thing sent to the endpoint.

Use it only after:

- the route is already known
- the primary user is known
- the primary object is known
- the data sources are known
- the allowed mutations are known

If those truths are missing, the endpoint will waste output on routing, missing-context warnings, and generalized shell advice.

When calling the endpoint for component resolution, always cap the output.

Use language like this inside the request:

- Return only the chosen route, 4 ranked component categories, and 2 alternates per category.
- Keep rationale to one sentence per item.
- No questions unless a required truth is missing.
- Do not restate general design philosophy.

## Framing

- Surface type: internal operations / company system
- Sector: policy-admin, approvals, queues, operational review
- Route: operational workbench
- Density: compact
- Primary interaction: scan, filter, select, inspect, update
- Dominant layout: left nav, top bar, main work surface, right context rail
- Dominant components: data tables, filter bars, status badges, queue lists, inspector panels, drawers, modals, toasts
- User posture: repeat user, high-frequency usage, low tolerance for decorative space
- Visual posture: sober, structured, restrained, semantic color only
- Avoid: hero sections, oversized cards, playful icon clusters, expressive marketing typography, abstract layouts

## What The API Should Return

- A chosen route and design profile
- The exact component candidates for that route
- A ranked component list instead of generic categories
- For each component: slug or id, title, why it fits, supported density, layout role, key states, and what to avoid
- A shell recommendation covering app shell, nav pattern, header pattern, toolbar pattern, table pattern, and inspector pattern
- A token posture covering typography, spacing, icon family, elevation, and motion rules
- A composition recommendation describing how the components should be assembled on the page
- A small set of near matches, ideally 2 to 4 alternates rather than a large vague list
- No-source summaries are acceptable only if they are precise enough to drive implementation

## What Would Make The Response More Useful

- Component anatomy: slots such as title, meta, actions, filters, row actions, bulk actions, and side rail content
- State coverage: loading, empty, error, selected, filtered, bulk-selected, disabled, success
- Data-shape compatibility: whether a component fits queues, metrics, tables, master-detail, or threaded assistant panels
- Variant guidance: compact or default, with or without badges, sticky toolbar, selection bar, pagination, inline actions
- Selection rationale: why this component beats nearby alternatives for this exact route

## Ideal Request Shape

```json
{
  "surfaceType": "internal-operations",
  "sector": "policy-admin",
  "route": "operational-workbench",
  "goal": "resolve precise component recommendations for an internal company portal",
  "constraints": {
    "density": "compact",
    "visualPosture": "serious, restrained, operational",
    "avoid": [
      "marketing hero",
      "editorial typography",
      "decorative card mosaics",
      "brand-forward abstraction"
    ]
  },
  "layoutNeeds": [
    "left navigation",
    "compact top bar",
    "filter toolbar",
    "table-first workspace",
    "right-side inspector",
    "drawer for edit flows",
    "toast feedback"
  ],
  "workspaceModules": [
    "command",
    "pipeline",
    "operations",
    "workforce",
    "assistant"
  ],
  "output": {
    "rankedComponents": true,
    "alternativesPerCategory": 3,
    "includeAnatomy": true,
    "includeStateCoverage": true,
    "includeCompositionGuidance": true,
    "includeTokenPosture": true
  }
}
```

## Ideal Response Shape

```json
{
  "classification": {
    "archetype": "internal-operations",
    "sector": "policy-admin",
    "route": "operational-workbench"
  },
  "designProfile": {
    "density": "compact",
    "typography": "quiet operational",
    "iconLibrary": "Lucide",
    "motion": "minimal functional",
    "elevation": "border-first"
  },
  "shell": {
    "appShell": {},
    "topBar": {},
    "sidebarNav": {},
    "toolbar": {},
    "inspector": {}
  },
  "componentRecommendations": [
    {
      "category": "table",
      "primary": {},
      "alternatives": []
    },
    {
      "category": "filters",
      "primary": {},
      "alternatives": []
    }
  ],
  "compositionPlan": [
    "header above toolbar",
    "toolbar above table",
    "selection bar appears on row select",
    "inspector binds to active row"
  ]
}
```

## Plain-English Summary

The core requirement is simple: move past broad discovery and resolve to the best-fit operational components for this exact UI class. This is not a marketing page or brand exercise. This is a dense internal workbench, so the response should prioritize implementation-ready components that support scanning, filtering, selection, and inspection.

## Concrete Pull Decisions

These are the decisions I would make from the current route and the portal that already exists.

- Primary shell to pull: IDE-style three-panel operational shell, but translated into a light operational product surface rather than a literal code editor clone
- Navigation pattern to pull: sidebar app shell or left-rail workspace navigation rather than wide horizontal pill navigation in the header
- Header pattern to pull: compact dashboard header with title, status context, result counts, and a restrained action cluster
- Core workspace pattern to pull: master-detail shell with table or queue on the left and sticky inspector on the right
- Filter pattern to pull: filter bar with chips, visible applied state, clear-all, and result count
- Data surface to pull: sortable data table with row actions, status badges, selection state, and optional batch action bar
- Editing pattern to pull: right-side drawer or sheet for create and edit flows
- Feedback pattern to pull: restrained toasts and inline state banners only where recovery or fallback needs to be explicit

## What Should Stay From The Current Design

- Keep the workspace split between command, pipeline, operations, workforce, and assistant
- Keep the idea that the table or queue is the primary work surface and the inspector is secondary
- Keep the edit flows out of the main work surface by continuing to use a sheet or drawer
- Keep the assistant as its own workspace instead of forcing it into every screen
- Keep semantic status treatment and the selection-driven inspector model

## What Should Change From The Current Design

- Replace the top-centered workspace tab row with a more operational left-side navigation model
- Reduce the amount of soft card treatment, large radii, and warm editorial atmosphere in the main shell
- Tighten headers and reduce oversized display text inside operational screens
- Convert the current simple filter forms into a proper compact workbench toolbar with visible active filter state
- Upgrade tables from static row lists into deliberate review surfaces with sorting, row actions, and clearer selected-state behavior
- Make inspectors more useful by including timeline, recent activity, related records, and next actions instead of only static field summaries
- Shrink the command workspace so it feels like triage and routing, not a decorative dashboard

## Current Flaws In The Existing Portal

- The overall shell is more polished than operational. The warm gradients, paper treatment, and large rounded surfaces create a softer editorial posture than this workbench should have.
- The global bar is doing too much. Brand, workspace switching, user state, and utility actions are all competing in one horizontal region.
- The command center is currently card-forward. It is readable, but it still leans too close to dashboard collage instead of urgent operational routing.
- The workspace headers are slightly too spacious and expressive for repeat-use back-office work.
- Filter bars are functionally correct but visually underpowered. They do not expose active state strongly enough and they do not yet feel like a serious operational toolbar.
- Inspectors are clean but shallow. They need more operational context and better action density.
- Tables are good as a foundation, but they are still closer to simple display tables than full review workbench tables.
- The assistant workspace is structurally sound, but its context rail is currently too thin to feel like a strong operational companion.

## Component Pull Priority

Pull these categories in this order.

1. App shell and navigation
2. Compact dashboard header
3. Filter toolbar with chips and result state
4. Table with actions and sorting
5. Master-detail inspector shell
6. Drawer or sheet editing pattern
7. Status and feedback patterns
8. Assistant thread and context components

## Component Choices By Workspace

### Command

- Use a compact operational overview header
- Use a thinner metric strip rather than large standalone metric cards
- Use queue modules focused on urgent work, blocked recovery, and near-term momentum
- Keep this page as a routing surface, not a full analytics dashboard

### Pipeline

- Use a dense table with selectable rows as the dominant surface
- Add a true filter toolbar with applied-state chips and count feedback
- Keep a sticky lead inspector on the right
- Support bulk actions only if the data volume or workflow needs it

### Operations

- Reuse the same table-plus-inspector shell as pipeline
- Bias the inspector more heavily toward timing, staffing, logistics, and execution checkpoints
- Use status and staffing risk as stronger visual signals than general decorative styling

### Workforce

- Reuse the operational table shell again for consistency
- Make due state, priority, and assignment more scannable
- Keep the fallback source banner, but visually subordinate it so it reads as system state rather than page identity

### Assistant

- Keep the three-column thread, conversation, and context layout
- Make the thread list denser and the context rail more useful by showing stronger attached entity context and recent actions
- Avoid turning this into a chat-marketing experience; it should read like an operational copilot surface

## Components To Reject For This Route

- Marketing hero shells
- Editorial landing page headers
- Oversized metric mosaics
- Soft, decorative card grids as the main interaction model
- Brand-led typography treatments inside work surfaces
- Large icon clusters used as decoration rather than orientation
- Hidden filter state or action state behind menus when the user needs constant visibility

## Implementation Direction

If I were executing this redesign, I would not rebuild every workspace from scratch with different visual logic. I would establish one operational shell and one reusable workbench pattern, then apply it consistently across pipeline, operations, and workforce.

The most important design decision is to make the shell more operational and less editorial. After that, the next most important move is to strengthen the filter-toolbar plus table plus inspector relationship, because that is where the actual work happens.

## Best-Fit Bundle Request

If the API can support a more decision-oriented request, ask it to return the following bundle:

- One primary shell recommendation
- One primary nav recommendation
- One primary toolbar recommendation
- One primary table recommendation
- One primary inspector recommendation
- One primary drawer recommendation
- Two alternates per category at most
- Explicit reasons these choices beat the alternates for a compact operational company portal