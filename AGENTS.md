# AGENTS.md — LevelUp

Instructions for AI agents working in this repository.

## Commit attribution

- Every commit made **through opencode** (i.e., by the AI agent) must append this
  trailer line to the commit message:

  `Co-authored-by: Misa AI <323098813+misa-ai-a@users.noreply.github.com>`

- Keep the commit **author** as the repository default identity (`anurag008w`).
- Do **not** add the trailer to commits the user makes on their own
  (terminal/IDE, no AI involvement) — those belong to the user only.
- Never duplicate the trailer if it is already present.

## Development status of Misa features

The following **Misa** features are currently **in development** (not production-ready).
Do **not** mark them as stable/done in docs, release notes, or UI copy. Bringing them
to production requires significant engineering work (error resilience, "no-answer"
handling, long-run stability, edge cases).

- **Misa Live voice** — real-time bidirectional voice & multimodal streaming.
- **Misa Memory** — conversation/context memory across sessions.
- **Proactive study nudges (messages)** — spontaneous auto check-ins & follow-ups.
- **Proactive WhatsApp-style calls** — live incoming calls for scheduled checks.

Keep this list in sync (`README.md` / `README.EN.md` / UI dev badges) whenever the
status of any of these changes.
