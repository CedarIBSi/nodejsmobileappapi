# Production Journal catalogue cutover

Prepared 18 October 2026. Compatibility code is approved for API deployment;
migration 040 is not applied to the live database yet.

The owner confirmed this checkout is the API repository and will run the
migration by hand only after the compatibility deployment and store testing.

The six production Apple/Google product IDs are defined in
`src/lib/storeCatalogue.ts`. Reference plan names use the owner's exact
IBSi FinTech Journal India Edition / Global Edition / Global + India Edition
wording with Monthly and Yearly suffixes.

## Compatibility before cutover

- Deploy `storeCatalogue.ts`, the verification changes in `subscriptions.ts`,
  and renewal lookup changes in `subscriptionReconcile.ts` first. Both old and
  new exact IDs resolve to their existing plan code. Provider receipts are
  still checked against the original requested ID before granting access.
- Deploy the mobile `findPlanForStoreProduct` restore fix in `E:/ibsi` before
  changing the plan response. Otherwise older receipts are silently ignored
  after the response starts listing the replacement IDs.
- Confirm the production deployment target and database. The checked-out
  repository's `.env` points to localhost; it must not be assumed to be the
  production database from another Windows machine. The repo's Azure workflow
  deploys pushes to `main` to `app-ibsi-api-prod`.

## Cutover and verification

On the **test server**, build the changed code, run `npm run migrate`, and
restart the test API together. Confirm the six new IDs at
`https://api.ibsintelligence.com/v1/subscription/plans` after the developer makes
the test changes available through that endpoint. The owner explicitly requires
`https://api.ibsintelligence.com` only for app/device testing. Keep the mobile
repo's existing `.env` unchanged; do not override it with another API host.
The following release steps happen only after that test run passes.

1. Verify new IDs and store customer prices on store-connected test devices,
   including both monthly/yearly options in India and the UK. Apple records are
   Prepare for Submission; six review notes are saved, real review screenshots
   and sandbox purchase/restore testing remain required.
2. Run the existing migration runner on the confirmed target, applying
   `040_production_subscription_catalogue.sql` inside its transaction. The
   migration verifies the expected six rows and known IDs before updating.
   It preserves plan UUIDs, product codes, edition grants, reference amounts,
   billing intervals, subscriptions, entitlements and transaction history.
3. Confirm `/v1/subscription/plans` returns the new IDs for both platforms and
   exact names, retaining all six existing plan UUIDs.
4. Test first purchase, cancellation of the purchase sheet, restore of a legacy
   receipt, restore after reinstall, renewal, plan changes, edition access,
   monthly archive restriction, and yearly full archive. Backend receipt
   verification and native acknowledgement must succeed before recording a pass.
5. Only then disable legacy products for new sales. Do not cancel subscribers,
   remove legacy mapping support, or erase original purchase tokens/history.

## Checks available without a phone

`npx tsx scripts/check-store-catalogue.ts` covers all six exact old/new aliases,
wrong-plan rejection, unrelated IDs, missing configuration, and direct custom
SKU matching. This is a compatibility test, not a sandbox transaction test.
`npx tsc -p tsconfig.json --noEmit` checks backend types without overwriting dist.

Validation completed: alias regression checks passed; the complete backend
`npm run build` passed in an isolated local copy of this source with the same
lockfile dependencies. The mapped-drive type check was stopped because of slow
SMB dependency reads. The database dry run could not connect from this machine
(connection timeout) and changed no data. Test-server API/PostgreSQL ports were
also unreachable from this laptop. The owner will run the test migration.

## Rollback

If the new products fail to load, restore the previous `apple_product_id`,
`google_product_id`, and plan names on the same six rows using a pre-cutover
snapshot. Keep compatibility code deployed so any new receipts already issued
continue to verify. Do not delete subscription or entitlement rows.
