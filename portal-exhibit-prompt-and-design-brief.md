# Portal Exhibit Prompt And Internal Brief

This document separates two things that should not be mixed together.

- External Exhibit prompt: used to get better design direction, component filtering, and shell recommendations from the Exhibit ecosystem.
- Internal portal brief: used to guide this product's actual implementation, naming, assistant behavior, and UI grammar.

## Difference Between The Two

### External Exhibit Prompt

Use this when asking Exhibit what kind of surface to return, what patterns to prefer, and what component references should drive the design pass.

- Do not mention the internal assistant name.
- Do not mention local implementation details unless they change the product model.
- Keep the prompt focused on surface classification, component choice, hierarchy, and operating posture.

### Internal Portal Brief

Use this when defining how the actual portal should behave.

- This is where the named assistant contract belongs.
- This is where the product lifecycle model belongs.
- This is where the UI grammar and action model belong.

## Request Contract For The Right Amount Of Guidance

The local agent endpoint behaves best when the request is staged and bounded.

Do not ask it to classify, redesign, choose components, and critique implementation in one shot.
That creates router-heavy output, meta warnings, and filler guidance.

Use this contract instead.

### Stage 1: Route Only

Use this when the surface type is still uncertain.

- Include: surface type guess, user type guess, primary task guess, current complaint
- Ask for: route, design profile, and at most 3 governing rules
- Do not ask for components or detailed UI yet

Example:

```json
{
	"stage": "route-only",
	"prompt": "This is an internal operations portal for managers. Primary task: move client relationships through qualification, scheduling, fulfillment, and follow-up. Current complaint: the shell feels too soft and dashboard-like. Return only: route, design profile, 3 governing rules. No questions unless a required truth is missing."
}
```

### Stage 2: Shell Refinement

Use this once the main truths are known.

- Include: primary user, primary object, data sources, allowed mutations, lifecycle, current shell failure
- Ask for: 3 shell rules, 3 control-system rules, 2 anti-patterns
- Keep the output capped and implementation-oriented

Example:

```json
{
	"stage": "shell-refinement",
	"prompt": "This is an internal operations workbench for managers coordinating acquisition, onboarding, fulfillment, scheduling, and retention. Primary user: manager. Primary object: client relationship, account, and event records. Data sources: CRM, scheduling API, internal task queue. Allowed mutations: assign, update status, schedule, add notes, move lifecycle stage. Current problem: shared workspace controls are too bulky and cause layout shifts. Return only: 1 route, 3 shell rules, 3 control-system rules, 2 anti-patterns. No questions unless a required truth is missing."
}
```

### Stage 3: Component Resolution

Use this only after route and shell posture are already settled.

- Include: chosen route, design profile, layout needs, workspace modules
- Ask for: ranked components, anatomy, state coverage, composition plan
- This is where the component-resolution prompt belongs

### Stage 4: Implementation Delta

Use this when a screen already exists and the issue is specific.

- Include: current screen purpose, exact failure, what must stay, what must change
- Ask for: a short diagnosis and a small set of changes
- Cap the response to avoid broad redesign chatter

Example:

```json
{
	"stage": "implementation-delta",
	"prompt": "The Clients workspace already exists. Keep the left rail, table-first surface, and right-side detail support. The current problem is that the scope controls are visually too heavy and the empty state causes the whole screen to shift. Return only: diagnosis, 4 changes, 2 things to avoid."
}
```

## Truth Packet

If these are missing, the router starts talking about missing context instead of helping.

- Primary user
- Primary object
- Data sources
- Allowed mutations
- Lifecycle or timeline
- Current failure

The endpoint does not need a full novel. It needs these truths stated plainly.

## Response Budget Rules

If the goal is the perfect amount of information at the perfect time, every request should define an output budget.

Use language like this:

- Return only the route and 3 rules.
- Return only 4 component recommendations and 2 alternates.
- Return only diagnosis and 5 implementation changes.
- No questions unless a required truth is missing.
- Do not include rationale longer than one sentence per item.

This keeps the endpoint from dumping a full router envelope when only a narrow decision is needed.

## Exact Prompt For Exhibit

Copy this exactly when you want Exhibit to help drive the next pass.

```text
This is an internal operations portal for a company system, not a developer tool and not a marketing surface.

Resolve this as an operational workbench with compact density and client-lifecycle-first logic.

The system should not be event-first. The primary object is the client relationship. Events, meetings, staffing, fulfillment, tasks, cadence, follow-up, and reporting are downstream operational states of that client lifecycle.

I need design direction and component filtering for these workspace types:
- Command: system picture and routing
- Clients: intake, qualification, meeting cadence, ownership, handoff readiness
- Operations: fulfillment cadence, scheduled work, staffing, delivery risk, execution follow-through
- Workforce: coverage, queue ownership, due-state, blocked work, completion review
- Assistant workspace: compact conversation lane with optional attached context, stronger first-step actions, smaller thread rail, and better hierarchy

Design constraints:
- serious internal company system
- operational compact density
- minimal decorative space
- table-first and queue-first work surfaces
- restrained icons
- compact headers
- visible state and ownership
- stronger first-step guidance
- minimal icon actions instead of bulky buttons where possible
- no developer language inside the UI
- no generic AI-marketing chat styling

Assistant workspace requirements:
- use the general assistant chat workspace as a baseline reference for the messaging lane
- also consider context-aware assistant console for context compression and complaint-to-working-brief behavior
- also consider artifact collaboration shell only for durable draft or revision patterns, not as a requirement for a full three-column layout
- thread names should stay generic until the first exchange is complete
- the thread rail should be smaller and denser
- context should attach only on demand and only when relevant records exist
- first-step suggestions should be strong and operationally useful
- support two behavioral postures in the same workspace: a discuss posture and an operational posture

What I need back:
- chosen route and design profile
- exact shell recommendation
- ranked component recommendations by workspace
- better hierarchy recommendations for headers, selection bars, tables, inspectors, and assistant chat
- specific guidance on how to reduce wasted space without losing clarity
- guidance on how to make the assistant surface feel more intentional and more useful in the first 10 seconds
- guidance on which patterns to reject because they would push this toward event-first thinking or developer-tool chrome

Avoid:
- developer workbench styling
- decorative card mosaics
- oversized pills
- hero sections
- too much persistent side context
- event-first framing
- chat UI that feels like a generic AI wrapper instead of an operational workspace
```

## Short Internal Design System Brief

This is the internal product brief for building the portal itself.

## Product Model

The portal is client-lifecycle-first.

- Client is the primary object.
- Meetings, cadence, fulfillment, staffing, events, tasks, follow-up, recovery, and reporting are downstream operational states.
- The interface should never imply that the system begins with an event.

## Core Lifecycle

The working lifecycle should read like this:

1. New client enters the system.
2. Intake and qualification establish fit, owner, and next meeting.
3. Cadence defines follow-up rhythm, meeting sequence, and decision movement.
4. Fulfillment covers scheduled delivery, staffing, event execution, and client follow-through.
5. Recovery handles blockers, misses, and delayed follow-up.
6. Review closes the loop with reporting, completion, and next-cycle preparation.

## UI Grammar

Every workspace should answer the same questions.

- What record is active?
- What stage is it in?
- Who owns it?
- What is blocked?
- What is the next move?

Use these rules:

- Command is for routing, not decoration.
- Tables and queues hold the moving inventory.
- Inspector panels hold ownership, risk, notes, and next-step context.
- Selection bars should make the focused record obvious and keep actions close.
- Drawers and sheets are for temporary edits, not primary reading.
- Status language should be human-readable, not raw enum text.

## Workspace Intent

### Command

- Purpose: orient and route.
- Should show system pressure, risk, and next queues.
- Should not become a dashboard collage.

### Clients

- Purpose: manage intake, qualification, cadence, and readiness.
- Should feel like lifecycle control, not just lead management.

### Operations

- Purpose: manage fulfillment cadence and scheduled delivery work.
- Should reflect meetings, staffing, scheduled activations, and follow-through.
- Should not imply that operations equals only the next event.

### Workforce

- Purpose: manage coverage, queue ownership, blocked work, and due-state.
- Should feel like execution support, not generic admin task entry.

### Assistant

- Purpose: help think, draft, route, and move work.
- Should feel like an operational workspace, not a generic AI wrapper.

## Assistant Contract

The named assistant contract is internal to this portal.

- The assistant name is Pura.
- That name belongs in the product, not in the external Exhibit prompt.

Pura has two modes.

### Discuss Mode

- Used for thinking, synthesis, planning, and drafting.
- Tone can be collaborative, but still practical.
- Best for summaries, follow-up wording, and reasoning through the next step.

### Operational Mode

- Used for movement, handoff, blockers, and action-first guidance.
- Should lead with next move, owner, blocker, and suggested action.
- Best for queue movement, operational review, and execution support.

## Context Rules

- Context should never be passed as raw selection state alone.
- Context should be compressed into a working brief before it reaches the assistant or drives the UI.
- A useful working brief contains: active record, lifecycle stage, owner, current risk, and expected next move.

## First-Step Standard

The first 10 seconds of a workspace should make the product feel capable.

- The assistant should show strong first-step prompts.
- The selected record should immediately imply the next move.
- The page should not require the user to interpret the product model before acting.

## Component Selection Rules

Use components because they fit the job, not because they look impressive.

- Use tables for live inventory.
- Use queue cards only for routing and urgency.
- Use inspectors for context and action support.
- Use chips and badges sparingly and semantically.
- Use compact icon actions where a full button is too heavy.
- Avoid persistent side rails unless they are earning their space.

## Ten-Out-Of-Ten Threshold

The main threshold to cross is semantic clarity, not visual polish alone.

The product becomes a ten when:

- the system clearly treats client lifecycle as the primary model
- each workspace has a specific operational purpose
- the assistant knows whether it is discussing or operating
- context is compressed before it is rendered or sent
- the UI grammar consistently exposes record, stage, owner, blocker, and next move

If those are solved, better components and faster design decisions follow naturally.