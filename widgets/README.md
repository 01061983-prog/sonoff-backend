# PACE native widgets backend

Opt-in integration; existing web routes and schedules retain their behavior. Enable only after deploying all files: `PACE_WIDGETS_ENABLED=true`. Reuses the existing Firebase database, active PACE identity, administrator UID binding, dashboard grants and encrypted eWeLink provider credentials.

## Configuration

Required existing configuration: PACE accounts and programming enabled, `EWELINK_APP_SECRET`, Firebase credential. No new billing plan is needed by this code.

Push requires `PACE_APNS_TEAM_ID`, `PACE_APNS_KEY_ID`, `PACE_APNS_PRIVATE_KEY` (PEM with actual newlines), `PACE_APNS_WIDGET_TOPIC` and `PACE_APNS_PRODUCTION=true` for TestFlight. Confirm the widget topic on a physical installation; expected extension topic is `it.gm83.pacewidgets.widget.push-type.widgets`. Store secrets in Render environment, never in Git or client code. Missing push configuration is reported as unavailable.

Cloud Monitoring requires read permission for the server service account and the Monitoring API. Without it, usage is unavailable rather than zero. Usage is project-wide and estimated; cache 15 minutes, requested only by superadmin.

New Firestore collections: `paceWidgetCodes`, `paceWidgetGrants`, `paceWidgetCommands`, `paceWidgetSubscriptions`. Codes are valid for two minutes and exchanged once. Hashes only are stored for bearer tokens. Configure optional Firestore TTL on `expireAt` for codes and command receipts; expiration is enforced in code even without TTL. Client SDK access to these collections must remain denied by existing default rules. Native access is through the authenticated server only.

## Verification

`node --test widgets/tests/*.test.cjs`

Tests use synthetic accounts/devices and send no real commands. Verify first-party browser login, canonical board scope, physical device snapshots and APNs end to end before declaring the beta operational. The stream adapter currently obtains the authenticated user key from owned devices; shared-only accounts require verification. Only the primary provider connection of each canonical PACE board is included.

No independent per-widget Firestore polling. One shared provider stream starts only for subscribed boards; reads/commands still recheck current authorization. A provider stream change can incur authorization and subscription reads before push delivery; the feature does not imply zero Firebase usage.

Rollback: unset `PACE_WIDGETS_ENABLED` and restart. Existing browser sessions, eWeLink grants and scheduled programs are preserved. Native widgets will report unavailable until re-enabled.
