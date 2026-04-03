---
name: commit
description: Create a git commit with the current changes following repository conventions and safety guidelines
---

Create a git commit. Follow these steps carefully:

1. Run these commands in parallel to understand the current state:
   - `git status` to see all untracked and modified files
   - `git diff` and `git diff --staged` to see changes
   - `git log --oneline -5` to see recent commit message style

2. Analyze the changes and draft a commit message:
   - Summarize the nature: new feature, enhancement, bug fix, refactor, test, docs, etc.
   - Use "add" for wholly new features, "update" for enhancements, "fix" for bug fixes
   - Focus on the "why" not the "what"
   - Follow the repository's existing commit message style
   - Keep it concise (1-2 sentences)

3. Stage and commit:
   - Prefer adding specific files by name rather than `git add -A` or `git add .`
   - Do NOT commit files that likely contain secrets (.env, credentials.json, etc.)
   - Use a HEREDOC for the commit message to ensure correct formatting:
     ```
     git commit -m "$(cat <<'EOF'
     Your commit message here.
     EOF
     )"
     ```

4. Show the result with `git log --oneline -1`

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify) or bypass signing (--no-gpg-sign) unless explicitly asked
- NEVER use `git commit --amend` unless explicitly asked — always create NEW commits
- NEVER use interactive git flags (-i) like `git rebase -i` or `git add -i`
- If a pre-commit hook fails, fix the issue and create a NEW commit (do not amend)
- Do not push to the remote unless explicitly asked
- Warn if staging files that look like secrets
- If there are no changes to commit, do not create an empty commit
