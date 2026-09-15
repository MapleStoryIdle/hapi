---
name: agent-team
description: Choose solo execution or a subagent team based on task complexity and risk. Use for implementation, debugging, review, testing, migrations, or deployment planning; skip simple factual questions.
---

# Agent Team

Route the current engineering task through the smallest safe execution team. The user's request and repository instructions always win.

## 1. Assess

Read the task and the nearest repository instructions. Classify:

- task type: reconnaissance, design, implementation, debugging, review, test, migration, or deployment;
- complexity: L0–L4;
- risk: production writes, destructive operations, secrets/permissions, schema changes, concurrency, multiple repositories, or unclear business rules;
- evidence gap: whether a read-only scout should collect facts first.

Read `references/team-profiles.md` only when the task may need delegation.

## 2. Route

- L0/L1, bounded, low risk: state the classification in one short sentence and work solo.
- L2–L4 or material risk: propose a team before spawning agents.
- Do not create agents merely because delegation is available.
- If the runtime has no delegation capability, say so briefly and continue solo with the same safeguards.

A team proposal must state the task, classification, reason, roles, scopes, mutation rights, and guardrails. Keep it compact.

## 3. Confirm

Do not spawn subagents until the user explicitly approves the proposed team. Existing approval for the same unchanged plan remains valid; do not ask again for each phase or retry.

Team approval does not authorize commits, pushes, deployments, deletion, production writes, or other external mutations. Obtain any missing authorization immediately before that action.

Use a structured choice tool for a genuinely blocking preference when one is available. Otherwise ask one concise question.

## 4. Delegate safely

- The lead owns decomposition, synthesis, verification, and the final response.
- Prefer at most three child agents: scout, implementer, verifier.
- Give each child a self-contained packet: objective, repository/branch, exact scope, prohibited actions, constraints, acceptance checks, and expected output.
- Use read-only agents for logs, database inspection, network research, and independent review.
- Use the cheapest available capable model for bounded scouting, a coding-capable model for implementation, and a stronger available model only for demanding diagnosis or review.
- Never invent a model or tool that the runtime does not expose.
- Agents may share a filesystem. Do not allow concurrent writers on overlapping files.
- Children must not commit, push, reset, merge, deploy, or delete unless the user separately authorized that exact action.

## 5. Verify

Treat child results as claims. Inspect relevant diffs, run focused checks, and resolve contradictions before reporting completion. If discovery materially expands scope or risk, pause the expanded part and propose a revised route.
