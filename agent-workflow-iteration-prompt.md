# Agent Workflow Iteration Prompt

Use this when the goal is not just route selection or component ranking.
Use it when the endpoint needs to preserve the full sophistication of the work so far, identify drift and workflow flaws, and return the right amount of guidance for the current iteration.

## Intent

This prompt is designed to do four things at once without collapsing into vague meta-guidance.

- preserve the strongest parts of the current system
- identify the major workflow flaws or drift risks
- decide what should be acted on now versus later
- return guidance in a cadence that is useful during UI iteration

## Required Inputs

Before using this prompt, fill in these fields plainly.

- Primary user
- Primary object
- Data sources
- Allowed mutations
- Lifecycle
- What already works
- What currently feels wrong
- What changed recently
- What must not be lost

## Context Hygiene Rules

More context is not always better. Mixed context is what causes drift.

Use these rules before sending the request.

- Name the target surface under review. Example: Clients workspace, Fulfillment workspace, cross-workspace control system, Assistant workspace.
- Include only recent changes that materially affect that target surface.
- Do not include auth, onboarding, or assistant details in a shell audit unless the current problem actually involves auth, onboarding, or assistant behavior.
- Separate stable truths from recent deltas. Stable truths define the operating model. Recent deltas define what changed in the last iteration.
- If the issue is system consistency, say that directly instead of dumping unrelated feature history.

Good:

- target surface: cross-workspace control system
- recent changes: compacted shared controls, removed sticky toolbar, stabilized empty states

Bad:

- target surface: cross-workspace control system
- recent changes: auth repaired, manager preview restored, local backend added, chat spacing changed

Those details may be true, but they distort the route if they are not relevant to the screen being audited.

## Cadence Packet

The endpoint responds best when the request is organized in this order.

1. Stable truths
2. Target surface
3. Current problem
4. Relevant recent changes
5. What must not be lost
6. Output budget

## Exact Request Body

```json
{
  "stage": "workflow-audit-and-iteration",
  "prompt": "This is an internal operations workbench for a company system. Primary user: [PRIMARY_USER]. Primary object: [PRIMARY_OBJECT]. Data sources: [DATA_SOURCES]. Allowed mutations: [ALLOWED_MUTATIONS]. Lifecycle: [LIFECYCLE]. Target surface under review: [TARGET_SURFACE]. What already works: [WHAT_ALREADY_WORKS]. Current problems: [CURRENT_PROBLEMS]. Relevant recent changes: [RECENT_CHANGES]. What must not be lost: [WHAT_MUST_NOT_BE_LOST].\n\nTreat this as an active product iteration, not a greenfield redesign. Preserve the strongest parts of the current direction unless they directly conflict with the operating model. Use the full available sophistication of the system, but only for the target surface and its directly related workflow. Evaluate shell hierarchy, control timing, context timing, selection model, inspection model, assistant behavior only if relevant, continuity across workspaces, empty/loading/error states, and action density.\n\nI do not want a generic redesign summary. I want the right amount of guidance at the right time. Diagnose the current state, identify major workflow pitfalls or drift risks, and separate what should be fixed now from what should be deferred.\n\nReturn only these sections:\n1. Current Direction To Preserve: 4 bullets\n2. Major Pitfalls Or Workflow Flaws: 5 bullets\n3. What To Fix In This Iteration: 5 bullets\n4. What To Defer Until Later: 3 bullets\n5. Prompting Or Workflow Adjustments: 5 bullets\n\nRules:\n- Keep each bullet concrete and implementation-relevant.\n- Do not restate the entire brief.\n- Do not ask questions unless a required truth is missing.\n- Do not collapse the answer into shell-only commentary if the problem is broader than shell.\n- Do not propose a full redesign unless the current direction is fundamentally wrong.\n- Call out timing and cadence problems explicitly when controls, context, or assistant behavior appear too early, too late, or too persistently.\n- Call out drift explicitly when recent changes improved one workspace but weakened system consistency elsewhere.\n- Ignore unrelated product areas even if they changed recently."
}
```

## Filled Example For This Portal

```json
{
  "stage": "workflow-audit-and-iteration",
  "prompt": "This is an internal operations workbench for a company system. Primary user: manager. Primary object: client relationship, account, event, and task records moving through acquisition, onboarding, fulfillment, and retention. Data sources: CRM, scheduling API, internal task queue, and role-based operational records. Allowed mutations: assign ownership, update status, schedule or reschedule work, add notes, move lifecycle stage, and route follow-up. Lifecycle: new client, qualification, cadence, fulfillment, recovery, review. Target surface under review: cross-workspace control system for Clients, Fulfillment, and Workday. What already works: the portal reads as a serious internal system, the workspaces are clearer, and the shared controls are more compact. Current problems: some surfaces still risk layout instability, some control systems can still feel heavier than the work they govern, and cross-workspace consistency can drift during local fixes. Relevant recent changes: shared controls were compacted, sticky workspace-toolbar behavior was removed, and empty states were stabilized. What must not be lost: the operational posture, the client-lifecycle-first model, the denser workbench feel, and the stronger first-step guidance.\n\nTreat this as an active product iteration, not a greenfield redesign. Preserve the strongest parts of the current direction unless they directly conflict with the operating model. Use the full available sophistication of the system, but only for the target surface and its directly related workflow. Evaluate shell hierarchy, control timing, context timing, selection model, inspection model, assistant behavior only if relevant, continuity across workspaces, empty/loading/error states, and action density.\n\nI do not want a generic redesign summary. I want the right amount of guidance at the right time. Diagnose the current state, identify major workflow pitfalls or drift risks, and separate what should be fixed now from what should be deferred.\n\nReturn only these sections:\n1. Current Direction To Preserve: 4 bullets\n2. Major Pitfalls Or Workflow Flaws: 5 bullets\n3. What To Fix In This Iteration: 5 bullets\n4. What To Defer Until Later: 3 bullets\n5. Prompting Or Workflow Adjustments: 5 bullets\n\nRules:\n- Keep each bullet concrete and implementation-relevant.\n- Do not restate the entire brief.\n- Do not ask questions unless a required truth is missing.\n- Do not collapse the answer into shell-only commentary if the problem is broader than shell.\n- Do not propose a full redesign unless the current direction is fundamentally wrong.\n- Call out timing and cadence problems explicitly when controls, context, or assistant behavior appear too early, too late, or too persistently.\n- Call out drift explicitly when recent changes improved one workspace but weakened system consistency elsewhere.\n- Ignore unrelated product areas even if they changed recently."
}
```

## Why This Works Better

- It preserves sophistication by explicitly asking for shell, controls, context timing, assistant behavior, continuity, and state handling together.
- It prevents drift by forcing the endpoint to name what should be preserved before it critiques what is wrong.
- It improves timing by requiring a now-versus-later split.
- It reduces filler by setting a tight output shape and forbidding a broad redesign summary.
- It keeps the endpoint useful during iteration because it critiques the product as it exists instead of pretending the work is starting from zero.