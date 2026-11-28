# Warehouse tracking via 17TRACK

The integration defaults to disabled. In an isolated staging environment, set `TRACK17_ENABLED=1` and store the staging `TRACK17_API_KEY` in the hosting secret store. Configure the 17TRACK webhook to POST to `/webhooks/17track` on the HTTPS staging host. Leave production configuration disabled until approved.

The existing background worker registers up to 20 outbound warehouse shipments per 30-minute cycle, from the last 30 days. It sends only the tracking number and an opaque warehouse shipment reference. Unsuccessful registrations retry after 24 hours. Registrations require the carrier to be identifiable by 17TRACK. Check coverage for the actual carrier and routes before enabling.

The webhook verifies the provider signature against the original request body and checks the shipment reference, tracking number and carrier. It maps supported latest statuses to the existing Shop tracking and notification system. Raw addresses and carrier descriptions are omitted. Cainiao polling remains available. Orders and payouts still use the existing operational delivery confirmation. Direct supplier parcels and Libya's separate carton records are outside this integration.

Before release, verify an outbound staging shipment for each configured carrier, send a signed test event, repeat the event to verify deduplication, and confirm that notifications reach accounts on a combined shipment. To disable the integration, set `TRACK17_ENABLED=0` in the deployment environment and disable the callback in the provider portal. Existing tracking history is retained.
