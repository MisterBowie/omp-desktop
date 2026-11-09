# Security Policy

OMP Desktop is a local-first desktop application for the Oh My Pi (OMP) coding
agent. We take security reports seriously and appreciate responsible
disclosure.

## Supported Versions

Security fixes are provided for the latest release published on the
[GitHub Releases page](https://github.com/MisterBowie/omp-desktop/releases).
Older releases and development builds may not receive security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Report privately through GitHub's private vulnerability reporting form:

<https://github.com/MisterBowie/omp-desktop/security/advisories/new>

If the form is not available, open an issue that asks for a private contact
without including any vulnerability details.

Please include as much of the following information as you can:

- A clear description of the vulnerability and its security impact.
- The affected OMP Desktop version, operating system, and package type.
- Reproduction steps or a minimal proof of concept.
- The affected component, feature, configuration, or extension boundary.
- Any relevant logs, screenshots, stack traces, or suggested remediation.

Please remove API keys, access tokens, passwords, private source code, personal
data, and other sensitive information before sending a report. Do not test
against other users, access data that does not belong to you, or perform
destructive actions. OMP Desktop does not operate a bug bounty program.

## Response and Disclosure

We aim to acknowledge a report within 7 calendar days and provide an initial
assessment within 14 calendar days. We will keep the reporter informed about
triage, remediation, and release plans when appropriate.

Please allow us reasonable time to investigate and release a fix before making
the vulnerability public. We will coordinate a disclosure date with the
reporter whenever possible and will credit the reporter in release notes only
with their permission.

## Scope

Reports are generally in scope when they affect the OMP Desktop application,
official release artifacts, Electron main or preload boundaries, the Rust host
core, the bundled OMP runtime integration and its tool permission gate, or the
handling of credentials, permissions, local files, plugins, MCP servers, or
IPC/RPC messages.

Issues that affect only the upstream Oh My Pi runtime, PI-Desktop, a
third-party provider, model service, operating system, dependency, or
user-installed plugin should also be reported to the relevant maintainer. They
are still in scope for OMP Desktop if the application introduces an exploitable
integration, permission, sandbox, or credential handling weakness.
