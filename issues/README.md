# RenderFlow — Issues & Feature Plans

This folder is the **pre-implementation design record** for RenderFlow.
Every file here is written _before_ code is touched — to think through architecture,
credit costs, API shapes, security impact, and deployment before a single line changes.

It is also the folder interviewers can read to understand how you think about
system design, not just how you write code.

---

## Index

| File                                               | What it covers                                                                        | Priority   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------- |
| [`SECURITY-ISSUES.md`](./SECURITY-ISSUES.md)       | Every real security gap found in the codebase — with fix plan for each                | 🔴 High    |
| [`ARCHITECTURE-GAPS.md`](./ARCHITECTURE-GAPS.md)   | Every known architectural gap — readiness probes, worker metrics, alerting, scaling   | 🔴 High    |
| [`FESTIVAL-MARKETING.md`](./FESTIVAL-MARKETING.md) | New feature: festival/event marketing template generator — full product + tech design | 🟡 Feature |
| [`CREDIT-SYSTEM.md`](./CREDIT-SYSTEM.md)           | How the existing credit engine applies to the festival marketing feature              | 🟡 Feature |
| [`DEPLOYMENT-DEMO.md`](./DEPLOYMENT-DEMO.md)       | How to deploy a live interview demo — Vercel + Railway + Neon + Upstash               | 🟢 Ops     |

---

## Why this folder exists

RenderFlow is a **learning and portfolio project** built to demonstrate:

- Decoupled event-driven backend (NestJS modular monolith + BullMQ workers)
- A real credit engine: atomic reserve → capture → refund, append-only ledger
- Transactional outbox for guaranteed queue delivery
- Full generation pipeline: content plan → image/video → schedule → publish
- Reliability: SIGKILL chaos test, lease/heartbeat, reaper, idempotent retry

These docs show the **thinking process** behind the system — what is broken,
what is planned, and why decisions were made — which is what interviewers
actually want to see.
