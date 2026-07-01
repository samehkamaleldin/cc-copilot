# Skills

Agent skills that teach an AI coding assistant to install, configure, and
troubleshoot cc-copilot for a user.

| Skill | What it does |
| ----- | ------------ |
| [`cc-copilot-setup`](cc-copilot-setup/SKILL.md) | End-to-end setup (preconditions → auth → configure → verify) plus a symptom→fix **gotchas playbook**. |

The skill is written in the portable **Agent Skill** format (`SKILL.md` with
`name` + `description` frontmatter), so it works across skill-aware agents. Below
is how to load it into the common ones.

---

## GitHub Copilot (VS Code)

GitHub Copilot doesn't read `SKILL.md` directly, so this repo also ships a
**prompt file** entry point that points Copilot at the skill:

- File: [`.github/prompts/cc-copilot-setup.prompt.md`](../.github/prompts/cc-copilot-setup.prompt.md)
- With the repo open in VS Code (Copilot **Agent mode**), run **`/cc-copilot-setup`**
  in Copilot Chat. Copilot will follow the skill, run the `cc-copilot` CLI, and
  walk the user through the interactive GitHub device login.

To make it available **outside** this repo, copy the prompt file into your user
prompt-files location (VS Code: *Chat: Configure Prompt Files*), or paste the
contents of `cc-copilot-setup/SKILL.md` into your repo's
`.github/copilot-instructions.md`.

> Copilot Agent mode needs terminal-command permission to actually run the
> install. The interactive `cc-copilot auth` step still requires the user to open
> the device-login URL and approve — the agent surfaces the code and waits.

## Claude Code

Personal (all projects):

```bash
mkdir -p ~/.claude/skills
cp -r skills/cc-copilot-setup ~/.claude/skills/
```

Project-scoped: copy to `.claude/skills/cc-copilot-setup/` in the target repo.
Claude Code auto-loads the skill by its `description` when relevant, or invoke it
explicitly.

## opencode

Copy into opencode's skills directory (personal):

```bash
mkdir -p ~/.config/opencode/skills
cp -r skills/cc-copilot-setup ~/.config/opencode/skills/
```

opencode discovers skills by their `name`/`description` and loads on match.

## Any other SKILL.md-aware agent

Drop the `cc-copilot-setup/` directory wherever that agent scans for skills. The
only required file is `SKILL.md`; it references the repo's `docs/` for depth but
is self-contained for the workflow itself.
