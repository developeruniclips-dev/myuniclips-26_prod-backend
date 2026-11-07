# Isolated Paystack Test sandbox — operator procedure

2026-11-07. Preparation instructions only. Nothing here authorizes provisioning,
publication, hosted database access, migration, activation or a payment. Use the
qualified isolated branches; never production main or an accepted worktree.

Owner-reported capacity: DigitalOcean 1 GiB/1 vCPU/10 GiB, 8/75 connections,
70–78% memory; Render Hobby with 750 free hours; Netlify Personal with 964.3/1000
credits and recharge off. These are owner observations, not a capacity guarantee.
Use Render Free, existing subscriptions and a bounded test window. Do not add a
paid disk, worker, database cluster, autoscaling or an additional recurring plan.
Any temporary November charge still requires an explicit concrete authorization.

## 1. Operator identities and evidence

Designate an approval custodian and an independent provenance reviewer, each
with an approved Ed25519 key. This implementation never generates operational
keys or decides who may sign. Upload only their distinct PEM **public** keys.
Keep private keys and credential files outside Git, worktrees, hosted services
and chat. Synthetic keys in tests are not operational authorities.

The custodian reviews source identity, merchant Test identity, NGN/fee settings,
metadata and writer inventory. The independent reviewer separately checks the
empty test schema/seed, academic relationships and absence of financial history.
A signature records a decision; it cannot prove the observations were honest.
Retain dated sanitized evidence and signed packets outside the application DB.

All JSON files below are UTF-8 without BOM, private operator files. Commands use
pinned Node 22.23.3 and already available dependencies. Do not put credentials in
arguments or shell history. Never run these against production or staging.
For a local operator checkout without `node_modules`, select the already reviewed
native dependency cache through `NODE_PATH`; do not install/copy packages into Git.

## 2. Provisioning order — requires separate authorization

1. Reserve a separate Netlify sandbox project to obtain frontend origin **F**.
   Leave the production project/domain/branch/env contexts unchanged. Retain the
   recorded main/accepted frontend divergence; publication is a later approval.
2. On the existing DigitalOcean cluster, create only `uniclipspsngsandbox`,
   `psngsandboxmigrator` and `psngsandboxapp`. Newly created managed users may
   inherit broad grants: revoke these before giving credentials to any service.
   Grant the migrator SELECT/INSERT/UPDATE/DELETE/CREATE/ALTER/INDEX/REFERENCES/DROP
   on that exact database; give the app only SELECT/INSERT/UPDATE/DELETE there.
   No roles, global privileges, other databases or GRANT OPTION. Verify SHOW
   GRANTS and a denied read of a production table without retrieving its data.
   Retain modern password authentication and verified TLS. Approve only the
   required Render outbound ranges; do not open all trusted sources.
3. Prepare the reviewed empty-schema bootstrap below from a trusted operator
   machine with the migration identity. No production dump, copied rows, real
   FUNAAB identities, payment history, global settings or automatic migrations.
4. Create one separate Render **Free** Node service, no production environment
   groups, automatic deployment disabled. Deploy only a separately authorized
   qualified source revision. Start command: `node src/sandbox/start.cjs`.
   Default `npm start` is still production startup and is NOT the sandbox command.
5. Obtain actual backend origin **B**, then publish the separately authorized
   sandbox frontend. No new domain/DNS is needed. Health and course preview may
   work while payments remain unavailable; no attestation is needed to boot.

## 3. Sandbox settings

Backend (service-scoped, not shared groups):

```text
UNICLIPS_SANDBOX=paystack-test-v1
NODE_ENV=test
PAYMENT_ARCHITECTURE=legacy_verified
DB_NAME=uniclipspsngsandbox
DB_USER=psngsandboxapp
DB_HOST=<actual managed hostname>
DB_PORT=<actual port>
DB_PASS=<private dedicated password>
DB_SSL=true
DB_SSL_CA=/etc/secrets/mysql-ca.pem
FRONTEND_URL=<F, no trailing slash>
ALLOWED_ORIGINS=<same F>
JWT_SECRET=<separate sandbox secret, at least 32 characters>
PAYSTACK_NG_AUTHORITY_PUBLIC_KEY=/etc/secrets/paystack-authority-public.pem
SANDBOX_REVIEWER_PUBLIC_KEY=/etc/secrets/paystack-reviewer-public.pem
PAYSTACK_NG_SECRET_KEY=<private Paystack Test secret>
PAYSTACK_NG_WEBHOOK_SECRET=<private active Test signing secret>
PAYSTACK_NG_LIVE_CHECKOUT=disabled
```

Initially leave `PAYSTACK_NG_TEST_CHECKOUT`, `PAYSTACK_NG_VERIFICATION` and
`PAYSTACK_NG_WEBHOOKS` disabled. At the separately authorized Test window, set the
specific approved controls to `enabled`. This can redeploy: obtain the challenge
**after** the deployment. Flags alone never activate payment operations.

Do not supply any Stripe secret/webhook secret, Vimeo token or SMTP password.
No Stripe SDK/router, registrations, uploads, emails, player, payouts or admin
routes are mounted by this entry point. There is no dummy Stripe key fallback.
Synthetic course metadata and entitlement checks exist; video playback is
deliberately unavailable. Use direct course `/course/401/301` for the first test.

Render supplies `RENDER_SERVICE_ID`/`RENDER_INSTANCE_ID`; do not substitute invented
values. The server computes canonical source identity (UTF-8 CRLF normalized to
LF, binary bytes unchanged), creates a new random generation/challenge each boot
and overrides inherited approval paths. Authority/schema/writer packet files
are installed privately under a new temporary directory; never upload a stale
writer packet as a Render secret file. Restart/sleep loses approvals, not DB data.

Netlify sandbox build only:

```text
UNICLIPS_SANDBOX=paystack-test-v1
SANDBOX_BACKEND_ORIGIN=<B>
VITE_API_URL=<B>/api
```

The header builder rejects a production/mismatched API or wildcard. It replaces
only the API/image origin; no Paystack script/frame source or SDK is introduced.
No public Paystack key is needed. Keep recharge off and leave production settings
unchanged. Monitor shared allowances; exhausting them can affect other projects.

## 4. Explicit synthetic bootstrap

`node scripts/paystackSandboxBootstrap.cjs` prints all 26 DDL statements and makes
no connection: 15 synthetic application/marker definitions plus 11 approved
payment/proof/transport definitions. This is a restricted checkout application,
not a full production-schema clone or general-purpose test environment.

Prepare private stdin JSON containing `merchantAccount`, `buyerEmail`,
`scholarEmail`, `buyerPassword`, `scholarPassword`; use synthetic accounts and an
owner-controlled Test mailbox acceptable to Paystack. No production user exists
here. Passwords must meet current strength policy.

```text
node scripts/paystackSandboxBootstrap.cjs --prepare-synthetic-seed
```

Supply that JSON on stdin. Save the returned object privately as `prepared`.
It contains Argon2id hashes, seed UUID/digest, bootstrap schema digest and source
digest; it contains no plaintext password. Do not commit it or print it in logs.

Create request `{host:<actual DB hostname>,prepared:<that object>}`. Run:

```text
node scripts/paystackSandboxApproval.cjs draft bootstrap bootstrap-request.json
node scripts/paystackSandboxApproval.cjs sign-reviewed bootstrap-draft.json <custodian-private-key-file>
node scripts/paystackSandboxApproval.cjs sign-reviewed bootstrap-draft.json <independent-reviewer-private-key-file>
```

Save each stdout result privately; these commands do not deliver or apply it.
Both reviewers inspect the same seed/schema/source/host and empty owned schema.
Within five minutes, supply `{seed:prepared.seed,authorization:<custodian envelope>,
independentReview:<reviewer envelope>}` on stdin to:

```text
node scripts/paystackSandboxBootstrap.cjs --execute-authorized-sandbox
```

Use the same sandbox env above, except `DB_USER=psngsandboxmigrator`, its private
password and local approved public-key/CA paths. This command can only use the
exact named test database/user and refuses a nonempty database before DDL.
It does NOT create databases/users. DDL is not transactional. A partial failure
requires inspection and separately approved recreation of only that owned empty
fixture; no automatic drop/resume. Seed writes share one transaction. No audit
or fabricated paid sale is seeded.
The successful result also contains normalized actual metadata and its digest;
retain it privately and compare it with the later runtime challenge, after the
independent full-definition/FK/index/CHECK review. A core validator is not a
replacement for that review.

The synthetic NG university ID 201 is explicitly labelled synthetic and unrelated
to live FUNAAB ID 55. Country NG, subject 401, Scholar 301, buyer 302, published
synthetic lessons 601/602 and fixed NGN offering are linked by actual FKs. Never
call this a zero baseline for real FUNAAB. The application pool is fixed at two
connections/four queued acquisitions and resets/verifies session UTC on every
lease; it never changes GLOBAL time zone/isolation.

## 5. Post-boot approvals and independent zero-history review

1. Read **`GET B/sandbox/challenge`** over verified HTTPS. Independently verify
   service/instance/source against Render and reviewed source, and actual schema
   metadata against the reviewed DDL. Compare metadata/schema digests. The status
   includes challenge, sequence and synthetic scope/seed digest; no secret.
2. `draft authorization` accepts request `{challenge:<GET body>,merchantAccount,
   callbackOrigin:F,independentlyReviewed:true,testSecretFile:<private external
   file>,webhookSecretFile:<private external file>}`. It reads secrets locally and
   outputs only their digests in an unsigned draft. Review fees absorbed, no
   splits, Test signing scheme `timestamped-v1` and individually approved controls
   before `sign-reviewed`. Maximum authorization life remains 24 hours.
3. Independently inspect all five writer entry points: checkout-confirmation,
   stripe-webhooks, admin-reconciliation, old-generations, workers. Record for
   each `{entryPoint,checkedAt:<epoch ms>,conclusion:"legacy-only-or-absent",
   evidenceDigest:<SHA256 of retained evidence>}`. `draft writer` takes
   `{challenge,observations:[...]}` and refuses missing/stale observations.
   Review/sign its exact output. It never discovers writers or signs automatically.
   Inventory every writer that can access this **test database**, including prior
   sandbox generations and operator tools. Production Stripe serving a different,
   inaccessible schema remains running; this is not a claim that it is stopped.
4. `draft packet` takes `{challenge,authorization:<signed>,writer:<signed>}`.
   Review/sign that outer draft. POST the envelope as JSON to
   **`B/sandbox/approvals`**, with verified HTTPS, without updating Render settings.
   Receiver checks boot challenge/identity, monotonic sequence, signatures,
   source/schema/metadata, credential bindings, control authorization and roster.
   No signing private key is uploaded. All transport is bounded/rate limited.
5. Independently inspect the manifest and empty purchase/proof/counter/order
   census for the synthetic scope. `draft zero-audit` takes `{challenge}`; the
   custodian reviews/signs it. `draft zero-review` takes `{challenge,audit:<signed>,
   independentlyReviewed:true}`; the other reviewer reviews/signs it. POST
   `{audit:<custodian envelope>,review:<reviewer envelope>}` to
   **`B/sandbox/zero-history`**. The endpoint accepts only this seed, empty facts
   and version 1. The unchanged importer locks/recounts and atomically imports
   the audit. Nonzero history is never admitted through this endpoint.

All drafts use `node scripts/paystackSandboxApproval.cjs draft <kind> <request.json>`;
all signatures use `sign-reviewed <draft.json> <external-private-key-file>`.
Inspect every draft. A boolean or evidence filename is not independent review.
Refresh a writer only after fresh independent observations: read challenge again,
retain the SAME authorization, draft/sign fresh writer and outer packet with the
next sequence. No automatic signing/renewal. A changed authorization requires a
fresh boot; old packets cannot authorize it. Writer lifetime stays five minutes.

## 6. First transaction — separately authorized

Configure only Paystack Test webhook `B/api/paystack/webhook`; callbacks are
constructed per order from F. Confirm Test merchant, NGN, processing fees borne
by UniClips, no splits/subaccounts/payouts, and the actual Test signing contract.
Use the synthetic buyer login and `/course/401/301`: quote NGN 150000 kobo,
explicit Paystack Test, owner-approved Test checkout only. Browser parameters
never grant access; verify through the authenticated backend/webhook.

Confirm exactly one entitlement with five calendar months, sale ordinal 1,
105000-kobo held allocation, original receipt and no Stripe/payout records.
Reverification must not extend access or initialize a second payment. After
expiry/restart, retain pending evidence and obtain fresh independent approvals;
never pay again to resolve uncertainty. Stop new checkout before the roster
expires; later verification needs a fresh valid roster. No automatic rollback,
financial replay, refund, revocation or database reset is authorized.

After the window, disable new checkout in the sandbox under its operational
authorization, retain evidence and reconcile uncertain outcomes. Agree test-only
resource removal/retention before November ends so no extra recurring service
survives; do not delete financial evidence automatically or touch production.
