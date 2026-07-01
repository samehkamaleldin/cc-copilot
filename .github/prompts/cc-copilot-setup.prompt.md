---
mode: agent
description: Install, configure, and verify cc-copilot so Claude Code runs on the user's GitHub Copilot subscription — and troubleshoot common issues.
---

# Set up cc-copilot

Follow the **cc-copilot-setup** skill in this repository:
[`skills/cc-copilot-setup/SKILL.md`](../../skills/cc-copilot-setup/SKILL.md).
Read it fully, then execute it for the user.

Your job:

1. **Check preconditions** — Node ≥ 20, git, Claude Code installed, and that the
   user has a GitHub Copilot plan. (A claude.ai account is **not** required.)
2. **Install** cc-copilot (clone + `./install.sh`, or the public one-liner).
3. **Authenticate** with `cc-copilot auth`. This is interactive: surface the
   GitHub device code + URL to the user and wait for them to approve — you cannot
   approve for them. Success = `Logged in as <user>` (a 0-byte token file does
   **not** mean success).
4. **Configure + start** with `cc-copilot install` (Foundry provider mode → no
   login gate; installs the OS background service).
5. **Verify** with `cc-copilot doctor`, then prove the proxy directly with a
   `curl` to `http://localhost:4142/v1/messages`, then `claude -p "Reply with
   exactly: CLAUDE_OK"`. No login prompt should appear.
6. **Report** how to use it: run `claude`; default model is **opus** (Opus 4.8,
   1M context); switch with `/model opus|sonnet|haiku|fable`.

If anything fails, use the skill's **Gotchas playbook** (§7). When unsure whether
a fault is the proxy or Claude Code, `curl` the shim directly — it bisects the
system.

Constraints:
- Prefer the `cc-copilot` CLI over hand-editing config; it's correct and
  reversible.
- Tell the user once that this is an unofficial, reverse-engineered bridge that
  can break and shouldn't be hammered (Copilot abuse detection).
- Never fabricate the device code or claim auth succeeded without confirming.
