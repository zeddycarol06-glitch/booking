# Dream Hotel booking app

## Features

- Guest booking form with live price quotes from the pricing engine
- Room inventory with per-type room counts, rates, and guest limits
- Availability checks: pending and confirmed bookings hold rooms; rejected and cancelled ones do not
- Pricing rules: weekend surcharge, festive-season multiplier, and long-stay discounts
- Manager dashboard with search (name, email, phone, reference), status filters, and an occupancy calendar
- Guest self-service page to look up, pay for, or cancel a booking with a reference and email
- M-Pesa (Safaricom Daraja) STK deposit payments, with graceful fallback when not configured
- Optional webhook notifications for booking and payment events

## Run locally

Use Node.js 20 or later. In PowerShell, open the project folder and start the server with a private manager password:

```powershell
$env:HOTEL_ADMIN_USERNAME = "manager"
$env:HOTEL_ADMIN_PASSWORD = "replace-this-with-a-unique-password-of-at-least-12-characters"
npm start
```

Open the booking page at <http://127.0.0.1:3000/>, the guest self-service page at <http://127.0.0.1:3000/track.html>, and the manager dashboard at <http://127.0.0.1:3000/admin.html>. Sign in with the configured username and password. Keep the terminal running while using the site; opening the HTML files directly with `file://` will not submit bookings.

If port 3000 is already occupied, set `$env:PORT = "3001"` before `npm start`, then use <http://127.0.0.1:3001/> and <http://127.0.0.1:3001/admin.html>. Always open the site from the same server process that handles `/api/bookings`.

Valid requests are saved in `data/bookings.json` and remain available after restarting the server. The data directory is excluded from version control. The server listens on `127.0.0.1`, so the manager dashboard is only available on the same computer; it is not configured for public or multi-device access.

Run the tests with:

```powershell
npm test
```

## Room inventory and pricing

Room types, nightly rates, room counts, and per-room guest limits live in `rooms.js`. Pricing rules (weekend surcharge, festive-season multiplier, long-stay discounts, and the deposit percentage) live in `pricing.js` — edit those files to change prices or inventory. The rooms page, booking form, guest self-service page, and dashboard all read prices from the server, so there is a single source of truth.

Availability is checked per night when a booking request is created and again when the manager confirms it. Confirming fails with HTTP 409 if every room of that type is already held for the requested dates; reject the overlapping request first or ask the guest for new dates.

### Pricing rules

| Rule | Default | Where |
| --- | --- | --- |
| Weekend surcharge | Friday & Saturday nights +20% | `PRICING_RULES.weekend` |
| Festive season | 15 Dec – 5 Jan ×1.4 | `PRICING_RULES.festive` |
| Long-stay discount | 7+ nights −10%, 14+ nights −15% | `PRICING_RULES.longStay` |
| Deposit | 20% of total, rounded up to the nearest KSh 100 | `HOTEL_DEPOSIT_PERCENT` |

Set `HOTEL_DEPOSIT_PERCENT` to change the deposit percentage (defaults to 20).

## Guest self-service

The `track.html` page lets a guest look up a booking with its reference and the email used to book. From there a guest can pay the M-Pesa deposit or cancel the booking. Pending bookings can be cancelled at any time; confirmed bookings can be cancelled up to 48 hours before check-in. Cancelling frees the room immediately for other guests.

## M-Pesa deposits (optional)

When Daraja credentials are configured, new bookings show a deposit that the guest can pay via M-Pesa STK push on the `track.html` page. On payment success the booking is automatically confirmed when a room is still available; if no room is free, the payment is recorded and flagged for the manager to resolve.

Set these environment variables to enable payments:

| Variable | Purpose |
| --- | --- |
| `MPESA_CONSUMER_KEY` | Daraja app consumer key |
| `MPESA_CONSUMER_SECRET` | Daraja app consumer secret |
| `MPESA_SHORTCODE` | Paybill / till shortcode |
| `MPESA_PASSKEY` | Lipa na M-Pesa online passkey |
| `MPESA_CALLBACK_URL` | Public HTTPS URL for the STK callback |
| `MPESA_ENV` | `sandbox` (default) or `production` |
| `MPESA_MOCK` | Set to `1` to simulate payments locally without Daraja |

Without credentials, the site works exactly as before: guests send booking requests and the manager confirms them manually. In mock mode (`MPESA_MOCK=1`) a payment succeeds automatically after a few seconds, which is handy for local testing. The server also polls the STK status on each guest poll, so it works locally even without a public callback URL; in production the `MPESA_CALLBACK_URL` speeds confirmation up.

## Notifications (optional)

Set `HOTEL_NOTIFY_WEBHOOK_URL` to receive a JSON `POST` for each event: `booking.created`, `booking.confirmed`, `booking.rejected`, `booking.updated`, `booking.cancelled`, `payment.received`, and `payment.conflict`. Point it at a service such as Zapier, Make, or n8n to forward events to email or SMS. Without this variable, events are only logged to the server console.

## API summary

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/rooms` | Public | Room types with rates, counts, and guest limits |
| `GET` | `/api/quote?roomType=&checkIn=&checkOut=` | Public | Price breakdown for a stay |
| `POST` | `/api/bookings` | Public | Create a booking request (validated, availability-checked, priced) |
| `POST` | `/api/bookings/lookup` | Public | Look up a booking by reference and email |
| `POST` | `/api/bookings/cancel` | Public | Cancel a booking (reference and email required) |
| `POST` | `/api/payments/stk` | Public | Start an M-Pesa STK deposit payment |
| `GET` | `/api/payments/:reference/status` | Public | Payment status (polls Daraja when configured) |
| `POST` | `/api/mpesa/callback` | Public | Daraja STK callback receiver |
| `GET` | `/api/bookings?status=&search=` | Manager | List bookings, optionally filtered |
| `PATCH` | `/api/bookings/:id` | Manager | Update status; confirming re-checks availability |
| `GET` | `/api/occupancy?from=&to=` | Manager | Per-day, per-room-type occupancy |
| `POST` | `/api/login` | Public | Manager sign in |
| `POST` | `/api/logout` | Public | Manager sign out |
| `GET` | `/api/session` | Public | Whether a manager session is active |
