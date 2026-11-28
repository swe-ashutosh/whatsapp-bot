# AGENTS.md - WhatsApp Bot Rules

> These rules apply to ALL agents working in this repository.

---

## 1. Package Manager Enforcement (CRITICAL)

- **Always use `pnpm`**. Never use `npm`, `npx`, or `yarn`.

---

## 2. Testing, TDD & Verification Protocol (CRITICAL)

- **Test-Driven Development (TDD):**
  - Follow TDD practices. Write unit tests for every new feature, helper, route, or message handler.
  - Never ship untested code or unverified bot handlers.
- **Break-the-Code Testing (Negative & Mutation Testing):**
  - Deliberately break or mutate code logic (invert conditions, pass bad payloads, simulate disconnects) to ensure tests FAIL.
  - If tests pass when the code is broken, fix the tests immediately.
  - Test boundary conditions, timeouts, rate limits, and error handling.
- **Master Integration Testing:**
  - Execute master integration tests to ensure Baileys socket flows, Supabase DB operations, and Hono API endpoints integrate without breaking existing flows.
  - Zero regressions: full end-to-end flow must remain functional.
- **Verification Gate:**
  - Never consider any task complete until unit tests, break-tests, and master integration tests all pass.

---

## 3. Response Style (For Agent Replies)

| Rule | Meaning |
|---|---|
| No over-explain | Get to the point. Skip extra background. |
| Simple words | Use easy words. Avoid heavy jargon. |
| Hinglish in chat | Chat replies use a Hindi + English mix. |
| English in the repo | Every file in the repo stays in English. |
| No long paragraphs | Break the answer into short pieces. |
| Points and tables | Use bullets or tables. |
| Proper spacing | Leave space between lines. Do not pack text together. |
| Crisp | Say only what is needed. |
| No em-dashes | Do not use an em-dash. Use a comma or a period. |

Apply this to every response: code, explanation, and discussion.
