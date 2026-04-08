# Portal Booking Integration

Booking-platform secrets are now expected through server-side environment variables, not through admin settings storage and not through checked-in files.

## Environment contract

- `PORTAL_BOOKING_API_KEY`
  - Required for any live booking-provider API call.
- `PORTAL_BOOKING_API_BASE_URL`
  - Optional until the provider base URL or API docs are confirmed.
- `PORTAL_BOOKING_PROVIDER`
  - Optional display label for internal status surfaces.
- `PORTAL_BOOKING_ACCOUNT_ID`
  - Optional provider-side account identifier when the integration needs one.

## Current wiring

- [lib/portalBooking.js](lib/portalBooking.js) resolves booking credentials server-side.
- [api/portal/admin_settings.js](api/portal/admin_settings.js) exposes only a non-secret integration summary.
- [scripts/portal_local_api_server.js](scripts/portal_local_api_server.js) mirrors the same non-secret summary for local preview.
- [ui/portal-os.js](ui/portal-os.js) shows whether the booking integration is configured without revealing secret material.

## Hosted setup

Set the same environment variable names in the deployment platform before relying on live booking API calls.

Example with Vercel CLI:

```powershell
vercel env add PORTAL_BOOKING_API_KEY production
vercel env add PORTAL_BOOKING_API_BASE_URL production
vercel env add PORTAL_BOOKING_PROVIDER production
vercel env add PORTAL_BOOKING_ACCOUNT_ID production
```

## Next integration step

Once the booking provider base URL and endpoint docs are confirmed, add a dedicated server-side client that uses `getBookingConfig()` and routes booking events into the existing public intake and lifecycle workflow surfaces.