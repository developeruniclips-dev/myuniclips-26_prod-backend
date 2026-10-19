# Local repository prevention — P2-J/J1 candidate

This is an explicit local developer control. No hook, CI setting, hosting setting or runtime selection is activated. It does not change application logic, dependencies, payments, uploads, database contents or production settings. P2-J is not complete/accepted; runtime evaluation belongs to J2.

## Run the guard

Use the accepted Node 22.16.0 and a separately acquired Gitleaks **8.30.1** binary. Obtain it only from the canonical [Gitleaks release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), compare the archive against the release checksums and GitHub API asset digest, then extract outside the repository. Never commit the binary, scanner reports or credentials.

Verified release payload SHA-256:

| Platform | Archive | Extracted executable |
| --- | --- | --- |
| Windows x64 | `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e` | `17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c` |
| Linux x64 | `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` | `88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509` |

Acquisition used HTTPS from `gitleaks/gitleaks` and matched published SHA-256 checksums plus GitHub asset digests. No detached signature asset was published for this release; a detached-signature verification is not claimed. Scanner upgrades require new review, tests and executable hash pins.

An owner/reviewer supplies an **external** JSON file with exactly one field, `paths`: a sorted array of the exact intended staged changed paths, with no duplicates. Do not generate that approval silently from whatever is staged. Missing, additional or reordered paths fail. Example shape: `{"paths":["README.md"]}` for a separately reviewed README-only change.

From the repository root, after separately authorized staging:

```text
node scripts/security/check-staged.cjs --allowlist /absolute/reviewed-allowlist.json --scanner /absolute/gitleaks
```

On Windows use the executable `.exe` path. Quote paths containing spaces. Exit 0 means this bounded guard passed; exit 1 means stop and review the sanitized code. It does not grant commit/push/deployment authority. This local candidate was tested using disposable indexes; the candidate's own index remains empty.

## Coverage and limits

The wrapper checks the complete index, not just the diff or working files. It reads full indexed text blobs through Git plumbing, including partial-staging and reused/renamed-blob cases. The exact changed-path allowlist is independent from the permanent prohibited-path policy. Index modes, paths and total/file sizes are preflighted before content reads. Conflicts, symlinks, gitlinks, case collisions, malformed paths, unknown binaries and unreviewed extensions fail for review.

Private env variants, CA/private-key files, media/upload directories, archives, credentials, analysis reports, dumps and generated/private artifacts are prohibited even if force-added. Legitimate source/manifests and reviewed public assets remain usable; JSON is not globally ignored. Only the root `.env.example` is allowed and its active/commented assignment values are vetted. Backend TLS documentation is preserved. The documented EMAIL_REQUIRE_TLS option does not change actual SMTP policy. VITE values are public bundle inputs; never add backend/provider/auth secrets to a frontend example.

Existing accepted frontend public raster assets, three OS metadata artifacts and the historical zero-byte SQL-named file are frozen by exact path/mode/Git object ID. The guard does not open or secret-scan those opaque objects; it rejects new or changed opaque entries. This preserves existing accepted files without a broad binary/artifact waiver. Deleting them would still require exact-path review and separate scope. No private archive, credential file or production media is scanned. Passing textual coverage does not certify opaque content or old history secret-free.

Existing reviewed synthetic assignments use exact file SHA-256/rule/line exceptions. Changing any byte invalidates those exceptions; new test secrets do not inherit a directory exemption. Policy/config changes require review. `.gitleaksignore`, inline `gitleaks:allow`, user configuration and scanner env overrides cannot silently exempt findings. `.gitleaks.toml` must equal the reviewed embedded configuration; the scanner runs in a private empty temporary directory with that configuration, no archive traversal, bounded decoding, sanitized environment and time/output limits. Only the nonsecret temporary config is written there and then removed.

The pinned executable is verified before invocation. Findings, crashes, missing/wrong-version tool, timeout, invalid report, unexplained exit status, budget failure or concurrent index change fail closed. Raw stdout/stderr, matched values and excerpts never enter CLI diagnostics; output is limited to safe codes, aggregate counts and hashed path IDs/rule/line locations. Any actual suspected credential exposure must stop work for private owner review; do not validate it against a provider, rotate, delete or rewrite history automatically.

## Tests and enforcement boundary

Set `J1_GITLEAKS_BIN` to the reviewed executable, then run:

```text
node --test --test-concurrency=1 tests/p2j.repository-guard.test.cjs
```

The suite creates disposable Git repositories/indexes referencing accepted public source objects. It stages only synthetic test content and candidate files there; it creates no candidate commit or production operation. Temporary fixtures intentionally remain available for local debugging; keep them out of Git, and do not reuse their approval manifests for a real release. A Linux export can supply `J1_SEED_REPO` for its public-source seed; this test-only variable is not a guard CLI bypass.

Run in a sanitized environment with no DB/provider/email credentials. No application imports, package install, database or live provider request is needed for this suite. Guard tests are not an application or production acceptance test.

Manual CLI controls can be bypassed by a developer who never invokes them or edits the wrapper; trusted hook/CI/branch enforcement would require a separate decision. Do not set `core.hooksPath` in linked accepted worktrees. No hosted enforcement is claimed. Pushing even tooling-only changes to main can trigger production autodeployment, so commit/push/deployment and upload preservation remain separate approvals. Never execute consumed production pause/resume scripts or journals.

## Combined P2-J release candidate

The reviewed runtime pin is exactly 22.23.3 in .node-version. Required regression evidence includes both 22.16.0 and 22.23.3; the guard itself remains compatible with both. Host runtime precedence must be verified before release; an overriding NODE_VERSION can defeat a repository pin. No dependency changes are included.

Selected enforcement is an explicit fail-closed local pre-commit hook, .githooks/pre-commit, plus a mandatory operator review before each release push. Its scanner and sorted exact allowlist must come from separately reviewed external files via uniclips.security.scanner and uniclips.security.allowlist Git config. Missing settings fail. Node preload/debug variables are cleared. Policy changes and exceptions require review; every byte change invalidates an old synthetic exception. The corrected backend log test retains the same synthetic assignment; only its reviewed blob hash is renewed. No new broad exception is added.

The hook remains INACTIVE during preparation. After final release approval, prefer per-command Git -c core.hooksPath=.githooks and the two explicit config values for the authorized commit; do not alter common linked-worktree configuration. Preserve hook executable mode 100755 at authorized staging. Hook bypass is possible with alternate configuration or --no-verify. No server-side or hosted CI enforcement is claimed, and no CI/host setting is activated. Render On Commit can deploy before a post-push check, so the operator must pass preservation, runtime and exact commit gates BEFORE pushing. Stronger hosted branch enforcement requires a separately reviewed activation decision.
