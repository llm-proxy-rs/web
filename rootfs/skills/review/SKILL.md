---
name: review
description: Review code changes for bugs, style, performance, and security issues
---

Review the current code changes. Follow these steps:

1. Determine what to review:
   - If the user provided a PR number, use `gh pr view <number>` and `gh pr diff <number>`
   - Otherwise, use `git diff` and `git diff --staged` for local changes

2. Analyze the changes for:
   - **Overview**: What do these changes accomplish?
   - **Correctness**: Are there any bugs, edge cases, or logic errors?
   - **Code quality**: Does the code follow project conventions and patterns?
   - **Performance**: Are there any performance concerns or regressions?
   - **Security**: Are there any security vulnerabilities (injection, XSS, auth issues)?
   - **Test coverage**: Are the changes adequately tested?

3. Present findings:
   - Lead with the most important issues
   - Reference specific files and line numbers
   - Suggest concrete fixes where applicable
   - Note any positive aspects of the changes
