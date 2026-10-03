# Security policy

## Reporting a vulnerability

Please report it privately through [GitHub's vulnerability reporting](https://github.com/Ryan-Choe/cite/security/advisories/new), not in a public issue. Include the steps to reproduce it and what an attacker gains. This is a personal project: reports are handled on a best-effort basis, and there is no bounty.

## How Cite is meant to run

Cite runs on your own computer with your own Anthropic API key, and every question spends that key's credit. So:

- `pnpm dev` and `pnpm start` listen on 127.0.0.1 only.
- `/api/ask` answers only its own page on this computer: it checks the `Host` header (which also stops DNS rebinding) and the `Origin` header, accepts only JSON (so other websites can't post to it without a CORS preflight, which it doesn't allow), and rejects bodies over 16,000 characters and questions over 500.
- The key lives in `.env.local`, which is git-ignored, and it is used only on the server.

Don't expose Cite to a network or deploy it as-is: it has no sign-in or rate limiting, so anyone who can reach it can spend your credit. Use a dedicated API key with a spending limit.

## In scope

- A way for a website or another device on the network to make a running Cite spend the owner's credit or read its answers
- A way for the API key to leak: to the browser, the logs or the repository
- A way for the answer to show a citation that doesn't match the handbook text it points to

## Out of scope

- Running Cite on a public address or behind a proxy, which it isn't designed for
- Programs already running on the same computer: they can call the local server just as the page does
- Vulnerabilities in dependencies that are already reported upstream (Dependabot tracks these)
- The handbook's own content
