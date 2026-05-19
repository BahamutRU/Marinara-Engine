# Issue 1020 proof

This directory contains the raw before/after output from `scratch/issue-1020-repro.ts`.

- `repro-before.json`: pre-fix run. It fails the compose HOME check, entrypoint HOME normalization check, and successful-but-empty Claude SDK stream check.
- `repro-after.json`: post-fix run. It passes the original checks plus adjacent checks for final-result fallback, non-streaming assistant text, and SDK error propagation.
- `docker-home.txt`: real `node:24-slim` container run showing the patched entrypoint drops to UID 1000 and resets the child process HOME to `/home/node` even when the container starts with `HOME=/app`.
