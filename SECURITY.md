# Security Policy

This project moves user funds, so we take vulnerabilities seriously.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through
[GitHub Security Advisories](https://github.com/Kiranchaudhary537/1click-wallet-transfer/security/advisories/new).

Include steps to reproduce, the affected chain, and the impact. We aim to acknowledge reports within
3 days and to fix critical issues before any public disclosure.

## In scope

- Funds sent to an address other than the one the user entered
- Wrong amounts, or funds left stuck because of a planning bug
- Anything that exposes keys or lets a third party (RPC, token list) change what gets signed
- XSS or injection in the UI

## Out of scope

- Tokens that can't be moved because of the token's own rules (frozen, blacklisted, paused)
- Rate limits of public RPCs or the DZAP API

## Using this tool safely

If your wallet is compromised, assume the attacker is watching it. Run the app locally from a commit
you have reviewed, double-check the destination address, and never paste a seed phrase anywhere.
