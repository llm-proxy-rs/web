---
name: memory
description: View and manage persistent memory files that store project context across sessions
---

Show and manage the persistent memory system:

1. Check for memory files:
   - Read `~/.claude/CLAUDE.md` (global memory) if it exists
   - Read `.claude/CLAUDE.md` in the current working directory (project memory) if it exists

2. Present contents clearly, separating global vs project memory

3. Ask the user what they'd like to do:
   - **Add**: Create a new memory entry
   - **Update**: Modify an existing entry
   - **Remove**: Delete an entry

4. When writing memory files:
   - Create the `~/.claude/` directory if it doesn't exist: `mkdir -p ~/.claude`
   - Keep entries concise and actionable
   - Use markdown formatting for readability
