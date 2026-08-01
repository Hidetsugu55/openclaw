# Hide Architecture Reassessment Notice

Status: active review gate for this fork  
Owner: Hide  
Created: 2026-08-02

## Purpose

This fork is part of Hide's local OpenClaw environment. Before making fork-specific changes for the custom harness, Builder Master, Knowledge Base, Codex, Claude Code, OpenCode, business automation, or PII handling, first verify what the current upstream OpenClaw already provides.

Review current upstream support for:

- native Codex integration
- ACP/acpx coding-agent integration
- agent and session lifecycle management
- per-agent workspace, sandbox, tool policy, and execution approval
- elevated and node execution boundaries
- Gateway routing, logs, health, cron, and security controls
- standard extension, plugin, skill, and connector mechanisms

## Required design direction

Do not add fork-specific infrastructure merely to preserve an older local design. Prefer upstream OpenClaw capabilities when they provide equivalent or stronger behavior.

Custom additions should be limited to demonstrable gaps in Hide's use cases, especially:

- broad read access to business services through constrained connectors
- local-only PII and secret handling
- explicit gates for messages, payments, contracts, bookings, prices, keys, and irreversible effects
- auditable evidence, verification, rollback, and operational status

## Mandatory next action

Before implementing architecture-affecting fork changes, compare upstream current behavior with `Hidetsugu55/openclaw-setup`, `Hidetsugu55/harness-and-builder-master`, and `Hidetsugu55/knowledge-base`, then report the findings to Hide.

Separate the report into Fact, Inference, Recommendation, migration risk, and the smallest useful vertical slice.

This file does not modify upstream project policy and should not be proposed upstream. It is a local-fork instruction for Hide's architecture review.