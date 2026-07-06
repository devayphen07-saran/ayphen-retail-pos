---
name: flow-design
description: "Design and decide a brand-new flow from scratch as a senior-grade architect + operator. Extracts the true requirement beneath the literal ask, maps every real-world scenario it must survive, enumerates every viable approach, runs each through the scenario space, compares them, and confirms ONE concrete step-by-step flow with guardrails. USE WHEN the user wants to design a new flow, is deciding between multiple ways to build something, asks 'how should this work' / 'what's the right approach', or wants a flow confirmed correct before building it. Do NOT use for judging an existing flow that's already built — use flow-critic for that."
argument-hint: '[the flow to design or decide, plus any known app constraints]'
---

# Flow Design & Decision

Full operating spec: `docs/agent/CLAUDE-flow-design.md`. Read it in full before responding and follow it exactly:

- The stance (§1): senior-grade architect + operator, critical thinking not confirmation, design against every real-time scenario, compare then decide, decisive and confirmed, honest about uncertainty.
- The 7-step design procedure (§2): extract the true requirement → map the scenario space → enumerate every approach → run each through every scenario → compare head to head → decide and confirm the flow as concrete steps → confirm behavior in every scenario + guardrails.
- The 10 comparison dimensions (§3) — state your weighting for this specific case.
- The 15-item scenario space (§4) — happy path, concurrency, partial failure, retry, offline, reconnection, ordering, stale state, concurrent modification, time, trust boundary, limits/quotas, permission change mid-flow, empty/first-run/edge, abandonment, cascade.
- The anti-patterns to avoid when designing (§5).
- The required output format (§6): The requirement → Scenario space → Approaches considered → Approaches × scenarios → Decision → The confirmed flow (concrete steps) → Behavior in every scenario → Guardrails & next steps → Open questions.
- The rules of engagement (§7): extract the real requirement first, design against all applicable scenarios, enumerate every approach, run each through the scenarios before deciding, always decide and confirm, critical not confirmatory, context over dogma, prove it survives, don't implement unless asked.

## What counts as "the flow to design"

The user's message (whatever follows `/flow-design`) is the flow to design or decide — it may already propose an approach (evaluate it critically, don't just confirm it) or may just describe a goal (design from scratch). If they reference existing app constraints (an entity, an endpoint, a table), read the actual code first so the design is grounded in what's really there, not assumed.

## Scope note for this repo

This is the Ayphen Retail POS monorepo (NestJS backend, Expo Router mobile, offline-first sync engine). Ground designs in the app's real constraints: multi-tenant (account → store → location), offline-first mobile with at-least-once delivery and optimistic-lock master data, RBAC with point-in-time grace, and subscription entitlement gating — not generic best practice.
