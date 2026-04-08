# Portal Operating Model

This document defines what the platform should actually be able to handle as the business grows.

It is not a UI mood board.
It is not a frozen process script.
It is the operating model the product should be built around.

## What This Platform Really Is

This platform is an internal operating system for managing client relationships from first signal through delivery, reporting, continuity, and recovery.

The product should not be built as:

- an event scheduler with extra tabs
- a CRM clone with prettier tables
- a task app with client data attached
- a chat wrapper with operational screens around it

The product should be built as:

- a client-lifecycle operating system
- a workflow and ownership engine
- a communication and cadence coordinator
- a fulfillment and reporting control layer
- a continuity and recovery system

## Core Product Truth

The primary object is the client relationship, usually represented by an account and the records attached to it.

Everything else is downstream of that relationship:

- intake submissions
- qualification and sales movement
- onboarding journeys
- meetings and appointments
- scheduled fulfillment
- staffing and dispatch
- event follow-up
- reporting
- retention and renewal work
- recovery and exception handling

The platform should never imply that a single event is the system's center of gravity.
Events matter, but they are downstream execution objects inside a broader client relationship.

## What The Business Actually Needs The System To Do

At a high level, the platform needs to coordinate five kinds of work at once.

1. Acquisition and Intake
It should absorb new leads, form submissions, referrals, and sales-stage movement without losing ownership or context.

2. Onboarding and Readiness
It should turn a new client or internal intake into a real operational journey with owners, checkpoints, requirements, and blockers.

3. Fulfillment and Delivery
It should manage scheduled work, staffing, logistics, dispatch, execution risk, and immediate follow-through.

4. Reporting and Closeout
It should coordinate recap, reporting, surveys, media, feedback, payout review, and client-facing closeout.

5. Continuity, Retention, and Recovery
It should keep the relationship alive after fulfillment through follow-up, issue handling, sentiment tracking, renewal preparation, and recovery plans.

## Product Principles

### 1. Cadence Must Be Configurable, Not Hardcoded

The platform should understand cadence without baking business timing into fixed UI logic.

That means:

- no hardcoded weekly or monthly assumptions in the product model
- no single universal meeting rhythm
- no assumption that all clients move through the same sequence
- no assumption that reporting, surveys, or follow-ups always happen at the same interval

Instead, cadence should be derived from:

- service type
- client segment
- program template
- account-level agreements
- lifecycle stage
- operational signals
- human overrides

Cadence is not a static calendar.
Cadence is a policy layer plus a next-action engine.

### 2. Workflow Should Be Signal-Driven

The platform should react to meaningful operational changes.

Examples:

- a lead qualifies
- an account has no owner
- an onboarding journey is blocked
- an event is missing staffing
- a report is still not complete after delivery
- client sentiment drops
- an account becomes at risk
- a workflow event fails

Signals should create or influence:

- next actions
- tasks
- notifications
- follow-up requirements
- assistant briefs
- health indicators

### 3. Humans Stay In Control

The platform should suggest, route, escalate, and compress context.
It should not silently automate critical client decisions without visibility.

The product should make these things explicit:

- who owns the current state
- what changed
- why something is blocked
- what the next move is
- what was automated versus manually decided

### 4. Communication Is Part Of Operations, Not A Side Feature

Cadence and communication are not separate from the work.
They are part of the work.

The platform should understand:

- internal handoffs
- manager review
- account follow-up
- client-facing messaging
- event follow-up
- survey and recap loops
- reminders and renewals

The product should treat communications as operational artifacts tied to records, triggers, and outcomes.

## The Flexible Lifecycle Model

The lifecycle should be understood as a common language, not a rigid script.

### Intake

Purpose:
Absorb new demand and normalize it into an actionable record.

What the platform should handle:

- sales forms
- referrals
- manual lead creation
- intake submissions
- deduplication
- source attribution
- basic qualification capture
- first-owner routing

Key outputs:

- normalized intake record
- linked client or account record
- initial owner
- first checkpoint
- workflow event trail

### Qualification And Early Movement

Purpose:
Decide whether the relationship is real, what it needs, and who should carry it.

What the platform should handle:

- meeting readiness
- qualification notes
- program fit
- scope definition
- ownership assignment
- next-contact plan
- early risk flags

Key outputs:

- stage progression
- owner clarity
- next meeting or action
- handoff readiness

### Onboarding

Purpose:
Translate a new client or internal intake into a real operating plan.

What the platform should handle:

- onboarding journeys
- required forms
- checklist completion
- readiness checkpoints
- account assignment
- manager review
- missing-owner detection
- blocked-journey detection

Key outputs:

- onboarding status
- target-ready date
- owner and manager linkage
- required data collected
- blockers with explicit accountability

### Fulfillment

Purpose:
Coordinate scheduled work and protect delivery quality.

What the platform should handle:

- appointments and meetings
- event scheduling
- staffing gaps
- dispatch work
- logistics and execution state
- media and coverage support
- real-time risk exposure

Key outputs:

- execution readiness
- staffing status
- delivery ownership
- open exceptions
- downstream follow-up requirements

### Reporting And Closeout

Purpose:
Close the loop after delivery and turn execution into durable client-facing and internal artifacts.

What the platform should handle:

- recaps
- media collection
- resident or participant feedback
- report drafting
- report sending
- payout review
- closure records
- post-delivery follow-up tasks

Key outputs:

- report state
- closeout completeness
- unresolved follow-ups
- durable reporting artifact

### Continuity, Retention, And Recovery

Purpose:
Protect the relationship after the immediate delivery cycle ends.

What the platform should handle:

- follow-up communications
- account issues
- account sentiment
- renewal timing
- retention signals
- recovery plans
- next-cycle planning

Key outputs:

- health status
- recovery actions
- continuity owner
- next-cycle opportunities

## The Object Model The Platform Should Grow Toward

The platform does not need all of this to exist as separate tables immediately, but it should conceptually support these objects.

### Client Relationship

The umbrella object representing the real business relationship.

May be expressed through:

- account
- company
- property
- contact cluster
- service agreement

### Intake Submission

The raw or normalized entry signal that starts a workflow.

Already aligns with:

- portal intake submissions
- sales forms
- onboarding forms

### Onboarding Journey

The readiness path for a person, account, or service setup.

Already aligns with:

- onboarding journeys
- checklist data
- required forms

### Service Program Or Operating Plan

The model that explains what the client is actually receiving and how that work should recur.

This should hold:

- service type
- service scope
- cadence policy
- checkpoints
- required artifacts
- communication rules
- escalation rules

### Execution Instance

A scheduled or concrete delivery unit.

Examples:

- meeting
- event
- dispatch activation
- staffing request
- survey wave

### Workflow Event

A durable record that something important happened in the workflow engine.

Already aligns with:

- portal workflow events
- ops triggers
- failure and retry handling

### Operational Task

A specific unit of work created by workflow, humans, or exceptions.

Examples:

- assign owner
- close staffing gap
- draft report
- send recap follow-up
- recover failed workflow

### Communication Artifact

A message, draft, summary, brief, follow-up, notification, or report connected to a real object and a real operational reason.

### Health Signal

Any status or signal that should affect routing, urgency, or continuity.

Examples:

- at risk
- owner missing
- sentiment falling
- report pending
- workflow failed
- readiness blocked

## How Cadence Should Actually Work

Cadence should not be modeled as a hardcoded schedule table with one fixed path.

Cadence should be generated from a combination of:

- lifecycle stage
- service package or program
- client-specific expectations
- recent activity
- required forms or artifacts
- unresolved blockers
- sentiment or health signals
- manual manager decisions

The right conceptual model is:

### Cadence Policy

Defines the rules of the rhythm.

Fields may include:

- applicable lifecycle stages
- recommended checkpoint intervals
- required interactions
- required artifacts
- escalation thresholds
- reporting expectations
- renewal preparation windows

### Cadence Instance

The live expression of cadence for a specific account, journey, or service plan.

Fields may include:

- current checkpoint
- next due action
- overdue state
- last completed touchpoint
- suppressed or paused state
- override reason

### Cadence Signals

The signals that change cadence behavior.

Examples:

- new survey response
- missed follow-up
- completed onboarding form
- unresolved issue
- sentiment drop
- rescheduled delivery
- manager override

### Cadence Outcomes

What cadence should create.

Examples:

- a task
- a reminder
- a communication draft
- a follow-up work order
- a workflow event
- a report requirement

This allows the platform to stay intelligent and adaptive without hardcoding the business into brittle UI rules.

## Communication Model

The platform should treat communication as part of execution, not as a disconnected inbox.

The system should support:

- internal assignment notices
- manager alerts
- onboarding requests
- follow-up drafts
- client recaps
- reporting emails
- renewal or relationship check-ins

Each communication should know:

- which record it belongs to
- what lifecycle stage it belongs to
- who it is for
- why it exists
- whether it is draft, queued, sent, failed, or acknowledged
- what workflow or signal created it

## What Pura Should Eventually Do In This Model

Pura should not be a generic chatbot.
It should be an operational reasoning layer on top of the lifecycle system.

Pura should be able to:

- compress selected record context into a working brief
- explain current lifecycle state in plain language
- identify blockers and missing data
- draft handoffs, recaps, follow-ups, and manager updates
- recommend next actions based on actual signals and ownership
- detect when a record is drifting or when cadence is broken
- help review workflow failures and recovery plans

Pura should not decide the lifecycle on its own.
It should reason over the lifecycle the product already knows.

## Existing Backend Seams This Model Should Reuse

The current platform already has useful seams that fit this operating model.

### Accounts

Already supports:

- ownership
- at-risk status
- ops triggers
- notifications
- account recovery tasks

### Onboarding

Already supports:

- intake submissions
- onboarding journeys
- checklist data
- required forms
- owner and manager linkage

### Workflow Events

Already supports:

- durable workflow records
- processing state
- failure tracking
- retries and recovery tasks

### Fulfillment And Follow-Up

Already supports:

- event records
- event follow-up generation
- dispatch creation
- staffing and logistics state

### Reporting

Already supports:

- report drafting
- recap integration
- media and feedback inputs
- closeout state

### Continuity Signals

Already supports:

- account issues
- account sentiment
- at-risk account triggers
- renewal reminder fields

The next implementation work should build on these seams, not replace them with a brand-new abstract system.

## What The UI Should Be Able To Show

At a product level, every workspace should be able to show some combination of:

- current lifecycle stage
- next required checkpoint
- owner
- blocker
- recent signal
- pending communication
- linked records
- current health state
- next move

This is the real grammar of the platform.
Tables, queues, inspectors, and assistant panels are just ways of expressing it.

## What Should Be Avoided

- Hardcoded business cadence in UI conditionals
- Event-first product framing
- Isolated forms with no workflow consequences
- Reporting as a dead-end artifact instead of a continuity input
- Tasks with no link to lifecycle state or owner intent
- Assistant prompts that are not grounded in real workflow context
- Dashboard metrics that are not actionable

## Implementation Priorities

If the platform is going to become real, the next priorities should be:

1. Normalize lifecycle objects across intake, onboarding, fulfillment, reporting, and continuity.
2. Add a configurable cadence policy layer instead of hardcoded rhythm logic.
3. Link communications and reporting artifacts to workflow events and lifecycle stages.
4. Make Pura operate on working briefs derived from real records and signals.
5. Give managers explicit continuity controls: owner assignment, blocker clearing, recovery planning, and next-cycle planning.

## Ten-Out-Of-Ten Standard

The system becomes a ten when:

- a new client can enter from a form and become a governed operational record
- onboarding can create readiness work without manual glue code
- fulfillment can expose staffing, readiness, and delivery pressure clearly
- reporting can produce real closeout and follow-up artifacts
- continuity can detect drift, risk, and renewal work before the relationship goes cold
- cadence can adapt by policy and signal instead of fixed hardcoded assumptions
- Pura can reason over the real operating model instead of over isolated screen state

That is the bar.