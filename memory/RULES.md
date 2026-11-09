# Memory

This project keeps structured memory in `memory/` (index: `memory/MEMORY.md`).

## Recall — Before Responding

Check memory when the message involves past decisions, preferences, system
knowledge, or prior work. Skip when the topic is already fully in context.

To recall: read the MEMORY.md index, scan descriptions for relevance, load
matching memory files. Don't load everything — be selective.

## Remember — After Responding

Run this decision tree after every substantive response:

1. **Does this exchange contain a user directive, reasoning conclusion, or
   durable fact?** If no to all, stop.
2. **Does an overlapping memory exist?** If yes, update it. If it contradicts,
   replace it. If no overlap, create a new file.
3. **Is it worth storing?** Multi-source synthesis or user-specific context
   that can't be recovered by search? Yes, save. Single-query public fact? Skip.

## Memory File Format

Save each memory as its own file in `memory/`, kebab-case, prefixed by type
(e.g. `feedback-persian-comments.md`):

```markdown
---
name: descriptive-name
description: one-line summary for relevance matching
type: user | feedback | project | reference
---

Content here. For feedback/project types, include:
**Why:** reason behind it
**How to apply:** when this matters
```

## What NOT to Save

- Code patterns or architecture derivable from the codebase or CLAUDE.md
- Git history (use git log)
- Debugging solutions (the fix is in the code)
- Ephemeral task details for the current session only
- Secrets, passwords, API keys, or tokens

## Index Maintenance

After creating or updating a memory file, add or update its entry in MEMORY.md.
Keep the index concise — one line per entry.
