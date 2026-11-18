# KINAN AI Development Workflow

## Roles
- Owner: approves each merge, deployment, and sensitive action.
- ChatGPT: audits, creates scoped GitHub Issues, reviews pull requests and CI.
- Claude Code: reads approved GitHub Issues, implements on a dedicated feature branch, runs local tests, and opens a pull request.
- GitHub Actions: checks syntax and runs tests on pull requests targeting main. It never deploys.

## Handoff
1. ChatGPT drafts an Issue with scope, acceptance criteria, tests, risk, and rollback.
2. Owner confirms scope; Claude Code selects the Issue through its GitHub connection. This workflow does **not** invoke Claude automatically.
3. Claude Code creates a fresh feature branch, commits code, and opens a PR referencing the Issue.
4. CI runs. ChatGPT inspects the diff and checks and reports findings.
5. Owner separately authorizes merge and deployment. Do not infer approval from a passed check.

## Security
- Never commit credentials, private customer information, or production exports.
- Use least-privilege GitHub tokens and read-only PR checks.
- Do not use pull_request_target to execute untrusted code.
- Enable branch protection or rulesets for main in repository settings: require PR, required status checks, and block direct pushes. This file cannot enforce those settings itself.
- Render auto-deploys main: treat merge as potentially triggering a production deployment. Require explicit owner approval for both before merging.
- If Claude is not configured to read GitHub Issues, the owner must initiate its work in Claude Code.
