# Nigeria Live pilot — unpublished implementation

This candidate does not activate payments, migrate a database or approve a
production deployment. Existing Test and Finland/Stripe paths remain separate.

Live is restricted to one reviewed buyer, subject and Scholar. Every provider
request requires the separate `single-owner-live-pilot-v1` owner authorization
and a fresh five-minute writer attestation bound to the process boot, runtime
source, service, instance and exact authorization. A restart clears approvals.
There is no automatic signing or renewal. This is a supervised pilot, not an
unattended public launch.

The NG course policy remains NGN 1,500, five calendar months of access, 70% to
the Scholar for the first 100 sales and 50% thereafter. Allocations remain held;
automatic Scholar payouts and bank onboarding are not implemented. The owner
must review the commercial terms and accept the payout hold before signing.
Nigerian Scholars do not need new Stripe onboarding. Existing Finland payment
and Stripe account-management behavior is preserved.

## Prerequisites before any publication or activation

- A genuine approved Nigeria/FUNAAB Scholar and published course, plus a
  different owner-controlled buyer. Never reuse synthetic sandbox IDs.
- A reviewed production database identity restricted to SELECT, INSERT, UPDATE,
  DELETE on its exact schema, global USAGE only, no roles or GRANT OPTION, and
  verified TLS 1.2/1.3 with the cluster CA and hostname verification.
- Separate review and authorization of the proposed Live table definitions,
  actual table/index/CHECK metadata, existing compatible core schema and audited
  historical baseline. The preview command only prints SQL; no executor is
  included. Never bootstrap or clear an existing database.
- Confirm the correct activated Live merchant, NGN, merchant-absorbed fees,
  no automatic split/subaccount, and timestamped Test-qualified webhook scheme.
  Live credentials belong only in private backend configuration outside Git.
- Review production rollout and rollback, existing writers and workers, terms,
  reconciliation and payout obligations. Keep all controls disabled meanwhile.

## Configuration contract — not instructions to enable production now

The candidate requires `NODE_ENV=production`, `PAYSTACK_NG_MODE=live`,
`PAYSTACK_NG_APPROVAL_MODE=single-owner-live-pilot-v1` and
`PAYMENT_ARCHITECTURE=legacy_verified`. Sandbox markers are forbidden.
`PAYSTACK_NG_TEST_CHECKOUT=disabled`. `PAYSTACK_NG_LIVE_CHECKOUT`,
`PAYSTACK_NG_VERIFICATION` and `PAYSTACK_NG_WEBHOOKS` default to disabled and
must remain disabled until the prerequisites and activation are approved.

The Ed25519 **public** PEM goes in `PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_PEM`, with
its SPKI DER SHA-256 in `PAYSTACK_NG_AUTHORITY_PUBLIC_KEY_SHA256`. No private
authorization key is loaded by the server. Existing database CA handling remains
unchanged. `DB_SSL=true`, the exact DB host/port/name/user, and verified CA are
required. `FRONTEND_URL` must be the exact HTTPS production origin included in
`ALLOWED_ORIGINS`; sandbox origins and databases are rejected.

Only an authenticated current SuperAdmin can request
`GET /api/paystack/live/challenge` or install an owner-reviewed packet with
`POST /api/paystack/live/approvals`. Both routes are rate limited. Drafting and
signing are owner-operated offline commands in `scripts/paystackLiveApproval.cjs`;
there is no Live zero-history convenience command. Keep private input files
outside the entire workspace. A signature never replaces factual review.

Startup checks the database identity, grants, TLS and actual schema before
opening HTTP. Failed startup reports a fixed safe error code. Unapproved,
expired, wrong-boot, replayed, wrong-key, Test-environment or out-of-scope payment
attempts fail closed. The frontend enables Live checkout only on an authenticated
server offering decision bearing the explicit owner-pilot marker.

Offline tests use synthetic keys and inert provider/database fixtures. They do
not establish production schema compatibility or authorize a real charge.
