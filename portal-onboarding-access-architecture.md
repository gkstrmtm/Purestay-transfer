# Portal Onboarding And Access Architecture

This document defines the correct onboarding, access, role-approval, and profile route for the portal.

It is meant to answer three questions:

- how people should actually get into the system
- how role correctness should be controlled
- what backend and profile surfaces need to exist for the product to feel like a complete employee app

## Current Read

The platform is not at zero.

It already has meaningful workflow foundation:

- user provisioning and access actions
- people directory and person records
- onboarding intake submissions
- onboarding journeys
- role authorization seams
- market assignment seams
- document tracking seams
- device access seams
- training and readiness seams
- talent profile support

The main problem is not missing primitives.
The main problem is that the end-to-end route is still split across multiple foundations instead of reading like one coherent onboarding system.

## Maturity Read

Current rough score by layer:

- workflow and onboarding foundation: 7/10
- access provisioning and admin control: 6/10
- role correctness and approval path: 5/10
- self-service account and profile experience: 4/10
- image and profile storage model: 3/10
- seamless employee first-login experience: 4/10

Overall read:

- platform foundation: 6/10
- employee-ready product flow: 4.5/10

That means the backend is materially ahead of the user journey.

## What Already Exists

### Access And Identity

- [api/portal/user_access.js](api/portal/user_access.js)
  - manager-driven provisioning
  - invite and reset flows
  - suspend and restore access
  - manager ownership assignment
- [api/portal/users.js](api/portal/users.js)
  - role correction
  - employment and readiness updates
  - manager assignment and home-base data
- [api/portal/me.js](api/portal/me.js)
  - current session, role context, capabilities, and person record
- [lib/portalAuth.js](lib/portalAuth.js)
  - role-aware session and capability model

### Onboarding And People Operations

- [api/portal/onboarding.js](api/portal/onboarding.js)
  - onboarding intake submissions
  - reviewable status model
  - onboarding journey creation
  - task and notification trigger support
- [api/portal/people.js](api/portal/people.js)
  - people directory
  - person detail
  - identity record lookup
  - employment profile lookup
  - role authorizations
  - market assignments
  - documents and device access records

### Profile And Employee Detail

- [api/portal/talent_profiles.js](api/portal/talent_profiles.js)
  - public and internal profile fields
  - avatar support today through data URLs in KV or profile storage fallback
  - coordinator-managed reliability notes
- [ui/portal-os.js](ui/portal-os.js)
  - settings account surface exists but is mostly read-only today
  - manager access controls exist

## Current Structural Problems

### 1. Signup Route Does Not Match Operating Truth

[api/portal/signup.js](api/portal/signup.js) still allows direct account creation for allowed email domains and defaults everyone to `dialer`.

That is useful for early testing, but it is the wrong long-term route for an internal workforce system.

This product should not behave like open self-serve SaaS.

Correct posture:

- invite first
- provision first
- approval first
- role-correct activation second

### 2. Requested Role And Approved Role Are Not Yet The Same Workflow

The repo already has:

- `subject_role` on onboarding intake
- role edits in people and users surfaces
- role authorizations in person detail

But the employee journey still does not read as:

1. requested role
2. approved role
3. access granted
4. dashboard routed by approved role

That needs to become explicit.

### 3. Self Profile Is Fragmented

The current state is split:

- account identity is in settings
- role and access are in manager settings
- rich profile lives in talent profile storage
- avatar currently uses KV-style data storage fallback

The user should experience this as one app identity, not three different subsystems.

### 4. Image Storage Is Not Production-Grade Yet

Avatar support exists in [api/portal/talent_profiles.js](api/portal/talent_profiles.js), but storing base64 image payloads in KV is only an interim move.

Long-term route should be:

- file upload to object storage
- durable asset record
- profile row references asset id or storage ref

## Correct End-To-End Route

The lowest-friction route is not public signup.

The lowest-friction route is managed activation.

### Target Flow

1. Manager or admin provisions a person
- Create or sync identity.
- Set initial approved role.
- Set manager owner.
- Set employment and readiness state.

2. System creates onboarding intake and journey
- Role-specific onboarding packet is attached.
- Required forms, training, and market data are routed conditionally.

3. Employee receives invite or activation link
- They do not choose arbitrary access.
- They activate the account already scoped to the approved role.

4. First login enters a guided setup route
- confirm name and contact details
- upload profile image
- complete role-specific basics
- confirm home base, market, or territory data when needed
- complete required documents and acknowledgements

5. Admin or manager approval completes readiness
- If the role is wrong, manager corrects it in review.
- If the person is not ready, they remain restricted.
- If approved, their dashboard and permissions route immediately from the approved role.

6. Employee lands in their real workspace
- This is my dashboard.
- This is my app.
- This is my profile and settings.
- This is my work queue.

That is the experience the system should create.

## Role Selection And Admin Approval

This should work as a controlled review system, not a trust-the-user selector.

### Recommended Model

Fields that matter:

- requested role
- approved role
- approval status
- approved by
- approved at
- restriction reason if blocked

### Practical Rule

The employee may declare or confirm what they think their role is.

The platform should not treat that as truth.

Truth should come from approval.

That means:

- onboarding intake may capture requested role
- manager or admin can override it
- approved role becomes the capability source
- role change writes audit trail and updates the routed workspace

Example:

- person chooses `account_manager`
- manager reviews and corrects to `remote_setter`
- access remains active but routed experience updates to sales posture
- readiness stays restricted until approval is complete if needed

## Conditional Onboarding Logic

Role-driven onboarding should branch from one common intake, not from isolated role-specific apps.

### Shared Core

Every person should have:

- identity and invite status
- approved role
- manager owner
- employment status
- readiness status
- required docs
- profile basics
- access audit

### Conditional Packets

Sales family:

- call standards
- lead handling expectations
- meeting and close workflow

Account Manager:

- client communication standards
- kickoff and cadence expectations
- retention and recovery posture

Event Coordinator:

- planning workflow
- staffing and logistics ownership
- reporting handoffs

Event Host:

- arrival and conduct standards
- event brief and recap gate
- rebooking and reliability expectations

Territory Specialist:

- regional oversight expectations
- handoff integrity review
- market or territory scope

## Backend Direction

The existing schema direction is strong enough to continue without a restart.

### Reuse Existing Foundation

Keep building on:

- `portal_profiles`
- `portal_people`
- `portal_user_identities`
- `portal_employment_profiles`
- `portal_intake_submissions`
- `portal_onboarding_journeys`
- `portal_person_role_authorizations`
- `portal_person_market_assignments`
- `portal_person_documents`
- `portal_device_access_records`

### Add Or Formalize Next

1. Separate requested role from approved role
- This can live in onboarding intake and/or role authorization rows.

2. Add approval-state routing
- restricted
- in_review
- approved
- rejected

3. Move avatar storage out of KV
- Use object storage.
- Reference assets by durable id or `storage_ref`.

4. Create a real self-profile surface
- editable name
- profile image
- bio or internal intro fields where relevant
- home base and contact details
- password reset and auth state

5. Connect first-login bootstrap to onboarding completion
- If the profile is incomplete, route to setup.
- If approval is pending, route to a waiting state.
- If approved, route to the role workspace.

## Frontend Direction

The frontend should not start by building a public signup page.

It should start by building three controlled routes:

1. Activation
- invite acceptance
- first password set if needed

2. First-Time Setup
- profile basics
- image upload
- required role-specific information

3. Pending Review Or Ready State
- pending review message if approval is incomplete
- direct handoff into the employee workspace when approved

Settings should then become the ongoing employee home for:

- profile
- image
- account security
- contact and home base
- manager and role visibility

## Territory Specialist Note

Territory Specialist should eventually become a data-heavy overview role.

It should center on:

- sales metrics
- pipeline movement
- regional or city performance
- account health by territory
- fulfillment drift by market
- handoff quality across roles

That is valid, but it is not the first blocking move.

The first blocking move is identity and onboarding coherence.

## Now vs Later

### Do Now

1. Deprecate open-style signup as the primary route.
2. Formalize invite or provision-first onboarding.
3. Add requested-role versus approved-role logic.
4. Add first-login setup route and pending-review route.
5. Move profile editing into a real self-service settings experience.

### Do Next

1. Move avatar and profile media to object storage.
2. Add explicit admin approval queue for onboarding intakes.
3. Connect role approval to final dashboard routing.
4. Add role-specific onboarding packets and checklists.

### Do Later

1. Territory Specialist regional overview workspace.
2. Rich portfolio and territory metrics.
3. Additional automation and agentic coordination after the human route is solid.

## Bottom Line

The platform already has the bones of a real internal employee system.

It is not missing the backend completely.
It is missing a single coherent employee journey.

That journey should be:

- provisioned or invited
- role reviewed
- approved
- completed through first-time setup
- routed into the right dashboard
- managed through one unified profile and settings surface

That is the next valid move.