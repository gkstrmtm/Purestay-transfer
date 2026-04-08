# Portal Role Capability Model

This document defines how PureStay roles should map into portal capabilities, workflow ownership, and Pura behavior.

It is not a job-post library.
It is a product-model document.

The goal is to keep role truth stable as the UI and assistant become more operational.

## Modeling Rules

Each role should be defined by:

- mission
- lifecycle entry point
- records they primarily own
- decisions they are allowed to make
- decisions they should never own
- operational signals they must watch
- handoffs they initiate or receive
- retention or delivery outcomes they influence
- the work Pura should be able to do on their behalf

Roles should not be merged just because they touch the same client.
Distinct accountability matters more than broad access.

## Account Manager

### Mission

The Account Manager owns client confidence after close.

They are the relationship lead from post-close kickoff through ongoing retention, rebooking, expansion, and recovery.

Their job is to make sure the client always feels informed, heard, supported, and aligned while the internal team stays pointed at the real promise PureStay made.

### Lifecycle Entry Point

The Account Manager enters immediately after sales close.

The first meaningful handoff is not an event setup task.
It is a relationship handoff.

The kickoff call is the Account Manager's opening move. On that call they:

- become the named point of contact
- collect property and demographic context
- set expectations for cadence, approvals, and communications
- align the first event window with the Event Coordinator

Only after that should the New Client Intake be considered complete.

### Primary Records

The Account Manager should primarily work from relationship records, not event records.

Primary objects:

- account
- onboarding journey
- kickoff readiness
- communication timeline
- client sentiment
- retention risks
- renewal and rebooking opportunities
- recovery plans
- meetings and checkpoints

Secondary objects they should be able to see, but not own directly:

- event schedule
- staffing status
- media status
- recap and reporting state

### What The Role Owns

The Account Manager owns:

- post-close client handoff quality
- kickoff completion
- relationship context capture
- expectation-setting with the property
- communication cadence
- account health visibility
- issue acknowledgment and recovery coordination
- retention readiness
- rebooking and expansion signal tracking
- making sure internal owners have what they need to deliver well

### What The Role Does Not Own

The Account Manager does not own:

- event design
- event-type selection
- staffing assignment
- host assignment
- media assignment
- logistics planning
- content creation
- calendar invite creation
- direct completion of EC or media forms

They can request, review, escalate, and confirm.
They should not be modeled as the execution planner.

### Key Operational Signals

The portal should surface these signals for an Account Manager:

- kickoff not scheduled
- kickoff completed but intake incomplete
- first event window not aligned
- client waiting on follow-up
- report not delivered on time
- sentiment drop or issue opened
- recurring client contact overdue
- renewal window approaching
- expansion signal detected
- property confusion about ownership or next step

### Handoffs

The Account Manager receives handoff from:

- closer
- manager
- onboarding intake

The Account Manager hands work toward:

- Event Coordinator for planning and execution readiness
- manager for escalations, recovery, or approval-path friction
- Pura for drafting, summarizing, triaging, and converting relationship context into actions

### Success Metrics

The role should be measured by:

- kickoff completion speed
- communication responsiveness
- follow-up reliability
- report and closeout continuity
- client sentiment stability
- retention rate
- rebooking rate
- expansion conversion
- recovery speed when issues appear

## Portal Implications For Account Manager

The UI for this role should be account-first.
It should not feel like a diluted event-ops console.

### Primary Workspace Shape

An Account Manager workspace should center on:

- accounts needing contact
- kickoff queue
- relationship timeline
- open client asks
- at-risk accounts
- renewal and rebooking queue
- unresolved recovery items

### Core Panels

The role needs panels for:

1. Relationship Status
Client health, owner clarity, current phase, next scheduled touch, open issues.

2. Kickoff And Onboarding Readiness
Closed-won handoff, missing context, kickoff scheduled or not, first event alignment status.

3. Communication And Cadence
Last touch, next touch, overdue outreach, pending client response, promised follow-ups.

4. Delivery Confidence
Execution status summarized at a high level so the AM can communicate clearly without becoming the planner.

5. Retention And Expansion
Renewal timing, rebooking pattern, upsell opportunity, sentiment, recovery state.

### UX Rules

The UI should let the Account Manager:

- see event risk without being pushed into event planning flows
- act on communication and relationship signals quickly
- confirm who owns the next move internally
- spot where PureStay is failing the promise before the client feels it
- move from a client question to a drafted answer, internal ask, or recovery plan fast

The UI should avoid:

- putting staffing and dispatch controls in the center of this role's workspace
- making the AM edit execution artifacts that belong to EC or field roles
- flattening retention work into generic tasks with no relationship context

## Pura For Account Manager

Pura should become the Account Manager's main operating lever for turning relationship context into action.

### Pura Should Be Good At

- summarizing a client account before a call
- drafting kickoff agendas and follow-ups
- turning event execution facts into client-safe updates
- spotting overdue promises and communication gaps
- preparing recovery language when something slips
- generating renewal, rebooking, or expansion talking points
- converting freeform notes into structured next steps
- identifying which internal owner needs to move next

### Pura Should Not Pretend To Be

- the event planner
- the staffing manager
- the creative strategist

For this role, Pura should sound like a relationship operator with strong internal visibility.

## System Implication

The portal should not model `account_manager` as an alias of `closer`.

Those roles touch the same relationship at different moments, but they own different decisions, different risks, and different success criteria.

This distinction should stay intact as additional roles are defined.

## Event Host

### Mission

The Event Host is the on-site face of PureStay.

They protect brand trust in the room by showing up early, presenting professionally, creating resident energy, and holding the experience together when something goes wrong.

They do not own the account relationship or the planning system.
They own the live representation of the brand during execution.

### Lifecycle Entry Point

The Event Host enters once an event is assigned and must confirm availability quickly enough for staffing to stay reliable.

Their work begins before arrival through assignment acknowledgement and event brief review, peaks during the live event, and ends only when the recap is submitted.

### Primary Records

The Event Host should primarily work from execution records.

Primary objects:

- assignment inbox
- event brief
- arrival and call-time expectations
- on-site checklist
- recap submission
- required photo or media confirmation
- incident or issue notes
- performance history tied to reliability

Secondary objects they should be able to see, but not own directly:

- account notes relevant to the event tone
- vendor timing and dependencies
- event objective and property expectations
- payout status after recap completion

### What The Role Owns

The Event Host owns:

- on-time arrival
- professional appearance and conduct
- on-site resident engagement
- following the event brief and approved script
- calm handling of missing components or light operational disruption
- checklist completion for setup and breakdown
- same-day recap submission
- protecting PureStay's reputation with residents and property staff

### What The Role Does Not Own

The Event Host does not own:

- event planning
- event-type selection
- staffing assignment
- vendor booking
- client strategy
- client retention planning
- media team management
- changing the event promise on-site without approval
- self-promotion or off-script pitching

They can escalate, improvise within guardrails, and preserve energy in the room.
They should not be modeled as the planner, seller, or account owner.

### Key Operational Signals

The portal should surface these signals for an Event Host:

- assignment awaiting response
- response window approaching 24 hours
- arrival time at risk
- missing pre-event brief acknowledgment
- event missing required host recap
- photos still missing when required
- lateness or conduct issue logged
- repeated recap delay
- performance strong enough for rebooking priority

### Handoffs

The Event Host receives handoff from:

- Event Coordinator through the event brief and assignment
- manager when special handling or escalation context is needed

The Event Host hands work toward:

- Event Coordinator when day-of execution issues affect delivery
- manager when conduct, lateness, safety, or escalation is involved
- recap and reporting flow immediately after the event closes
- Pura for pre-event briefing, issue handling language, and recap compression

### Success Metrics

The role should be measured by:

- on-time arrival rate
- assignment response reliability
- recap completion speed
- checklist completion consistency
- professionalism and conduct quality
- client or manager confidence in rebooking
- calm issue handling under pressure

## Portal Implications For Event Host

The UI for this role should be day-of execution first.
It should feel like a field-ready control surface, not a planner dashboard.

### Primary Workspace Shape

An Event Host workspace should center on:

- incoming assignments needing confirmation
- upcoming events by date and call time
- arrival expectations
- event brief and checklist access
- recap-required events
- performance and reliability signals that affect future booking

### Core Panels

The role needs panels for:

1. Assignment Queue
Pending offers, response deadline, event location, date, and whether the slot will roll to another host.

2. Day-Of Brief
Arrival time, property context, event objective, script notes, setup and breakdown checklist, escalation contact.

3. Live Issue Handling
Fast path for food delay, missing component, property confusion, or other light disruption with clear escalation routing.

4. Recap Gate
Attendance estimate, required photos, notable issues, and same-day submission status tied to payout readiness.

5. Reliability And Rebooking
Signals that show whether the host is building trust through timeliness, professionalism, and recap discipline.

### UX Rules

The UI should let the Event Host:

- confirm or decline assignments quickly
- understand exactly when and where to arrive
- access the event brief without digging
- stay focused on execution rather than internal system noise
- submit a recap immediately from the same operational flow

The UI should avoid:

- exposing planning controls that belong to the Event Coordinator
- burying recap behind admin-heavy forms
- mixing client-retention analysis into the host's main workflow
- encouraging off-script creativity that changes the promised experience

## Pura For Event Host

Pura should function as an execution copilot for the Event Host.

### Pura Should Be Good At

- summarizing the event brief into a fast pre-arrival read
- listing the first things to check on arrival
- helping the host respond calmly when a component is late or missing
- turning rough post-event notes into a clean recap draft
- reminding the host what matters for rebooking and payout readiness

### Pura Should Not Pretend To Be

- the event planner
- the account manager
- the person changing the event concept on the fly

For this role, Pura should sound like a composed field operator who helps the host stay sharp, professional, and fast.

## System Implication For Event Host

The portal should treat recap completion as an operational gate, not a soft reminder.

For this role, recap is part of the job completion state and part of the payout-readiness state.

## Sales Family

The remaining sales roles should stay lean in the product model.

They matter operationally, but they should not each spawn a completely separate operating system inside the portal.

### Shared Sales Mission

Sales roles create forward movement from first outreach through booked meeting and close.

The common job is to:

- generate qualified conversations
- move a prospect to the next committed step
- preserve context through handoff
- make sure revenue opportunity does not die from ambiguity or delay

### Shared Sales Objects

The sales family primarily works from:

- lead records
- outreach history
- call notes
- appointment pipeline
- qualification state
- close readiness
- next-touch commitments

### Compact Role Split

`dialer` and `remote_setter`:

- own first outreach and meeting generation
- should optimize for contact rate, qualification, and clean next step capture

`in_person_setter`:

- owns in-person or higher-friction movement toward commitment
- should optimize for situational qualification and committed follow-through

`closer`:

- owns proposal, decision path, and deal close
- should optimize for fit, urgency, objection handling, and explicit handoff into Account Manager ownership

### Sales UX Rule

Sales screens should stay movement-first.

They should center on:

- next call
- next appointment
- next decision
- stalled leads
- handoff readiness

They should avoid becoming mini versions of account management or fulfillment workspaces.

## Territory Specialist

### Mission

The Territory Specialist is a regional overhead operator.

They are not just another seller, and they are not a classic people manager.

Their job is to keep a territory coherent across sales movement, account continuity, and fulfillment alignment so regional performance does not depend on one overloaded manager carrying every follow-up and exception personally.

### Lifecycle Entry Point

The Territory Specialist enters wherever regional continuity starts to break down or needs active oversight.

That means they should be able to step into:

- pipeline review
- cross-role handoff quality
- onboarding friction
- account drift
- regional execution risk
- renewal and expansion pattern review

They are not the first-touch owner of every record.
They are the role that sees across the handoffs and keeps the region from fragmenting.

### Primary Records

The Territory Specialist should primarily work from cross-workflow oversight records.

Primary objects:

- territory-level pipeline summary
- account portfolio health
- onboarding readiness across accounts
- fulfillment risk across upcoming work
- unresolved cross-role handoffs
- renewal and retention exposure by region
- expansion and rebooking signals
- owner gaps and stalled records

Secondary objects they should be able to inspect deeply when needed:

- individual leads
- appointments
- account timelines
- event readiness snapshots
- issue and sentiment history
- task queues across roles

### What The Role Owns

The Territory Specialist owns:

- regional continuity across sales, account management, and fulfillment
- early detection of handoff failure between teams
- keeping owners clear when a record drifts or stalls
- identifying where a territory is underperforming or overloaded
- surfacing what needs escalation before it becomes a manager fire
- helping protect retention and expansion outcomes at the regional layer

### What The Role Does Not Own

The Territory Specialist does not own:

- direct people management by default
- broad admin configuration
- every client-facing relationship personally
- detailed event planning execution
- replacing the Account Manager, Event Coordinator, or closer in normal flow

They should be modeled as a regional operator and force-multiplier, not as a second manager console.

### Key Operational Signals

The portal should surface these signals for a Territory Specialist:

- leads stalling before appointment
- deals closed without clean AM handoff
- kickoff lag by region
- onboarding journeys blocked across multiple accounts
- event readiness risk clustering in one territory
- reports or recaps slipping in a pattern
- account sentiment decline by region
- renewal windows approaching without ownership clarity
- rebooking or expansion opportunities with no coordinated next move
- one team member carrying too much unresolved work

### Handoffs

The Territory Specialist receives signal from:

- sales activity and appointment flow
- Account Manager continuity and client health
- Event Coordinator execution risk
- manager escalation when territory-level coordination is needed

The Territory Specialist hands work toward:

- closer when revenue movement needs help
- Account Manager when relationship continuity needs a named owner
- Event Coordinator when delivery readiness needs correction
- manager when authority, staffing, or personnel intervention is actually required
- Pura when cross-role context needs to be compressed into a clear next move

### Success Metrics

The role should be measured by:

- handoff quality across sales to AM to fulfillment
- reduction in stalled records and owner ambiguity
- regional renewal and rebooking health
- reduction in preventable escalations reaching the manager layer
- visibility into regional risk before client trust drops
- portfolio throughput without quality loss

## Portal Implications For Territory Specialist

This is one of the heaviest platform-usage roles.

The UI should feel like a regional operating cockpit, not a people-admin console and not a generic dashboard.

### Primary Workspace Shape

A Territory Specialist workspace should center on:

- regional pipeline movement
- handoff integrity
- account health by territory
- onboarding and kickoff drift
- fulfillment risk clusters
- renewal and expansion opportunities
- unresolved ownership gaps

### Core Panels

The role needs panels for:

1. Territory Flow
Movement from lead to appointment to close to kickoff to fulfillment.

2. Handoff Integrity
Where sales, AM, and EC transitions are incomplete, late, or ownerless.

3. Regional Risk
Accounts, events, or teams showing concentration of delivery, sentiment, or cadence problems.

4. Portfolio Opportunities
Rebooking, renewal, and expansion openings that need coordination rather than just awareness.

5. Escalation Compression
What the manager would otherwise have to sort manually, reduced to clear next decisions.

### UX Rules

The UI should let the Territory Specialist:

- move between sales, account, and fulfillment context without losing the thread
- see where the region is slipping before it becomes a direct manager escalation
- reassign focus and clarify next owners without dropping into admin-heavy settings
- use Pura as a coordination lever across multiple workflows

The UI should avoid:

- collapsing this role into the same experience as manager
- forcing the role to work one record at a time with no regional compression
- turning the workspace into a KPI wall with no operational next moves

## Pura For Territory Specialist

Pura should be especially strong for this role.

### Pura Should Be Good At

- summarizing a territory across sales, account, and fulfillment risk
- identifying the next owner and next move for drifted records
- turning a messy regional situation into a short action plan
- drafting internal follow-through across roles
- spotting emerging patterns before they become manager-level fires

### Pura Should Not Pretend To Be

- a regional manager with direct authority it does not have
- a replacement for role owners doing their own work
- a generic BI summary bot

For this role, Pura should sound like a sharp regional operator that can compress cross-functional mess into decisions.

## System Implication For Territory Specialist

Territory Specialist should be treated as an operator-tier role with broad workflow visibility and coordination value, but not automatically as a full admin or people-management role.

That distinction matters if permissions are expanded later.