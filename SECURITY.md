# Security policy

## Boundaries

- DSH and CLI execution is restricted to an explicit workspace. The manifest fixes argv, cwd, warmup/repeat, timeout, output bytes and concurrency; subprocesses use `shell: false` and a sanitized environment.
- Only trusted benchmark executables should be used. These controls are evidence and accident-containment boundaries, not an OS sandbox for hostile code.
- Reports exclude argv, stdin, raw stdout/stderr, inherited environment, timestamps and hostnames. Secret-bearing manifest fields are rejected.
- Artifact writes are limited to an explicit workspace-relative `artifactDir`, protected against traversal and symlink escape, content addressed, and verified after read-back.
- The standalone MCP server never executes commands or reads/writes the filesystem. It only validates a bounded inline manifest or computes and summarizes a bounded inline report address.

Please report vulnerabilities privately through GitHub Security Advisories. Do not include credentials, private benchmark inputs, or raw business output.
