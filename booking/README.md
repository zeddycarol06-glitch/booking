# Dream Hotel booking app

## Features

- Guest booking form with live price quotes (nights × nightly rate)
- Room inventory with per-type room counts, rates, and guest limits
- Availability checks: pending and confirmed bookings hold rooms; rejected ones do not
- Manager dashboard with search (name, email, phone, reference) and status filters
- Pricing stored on each booking, with a total column in the dashboard
- Optional webhook notifications when bookings are created, confirmed, or rejected

## Run locally

Use Node.js 20 or later. In PowerShell, open the project folder and start the server with a private manager password:

```powershell
$env:HOTEL_ADMIN_USERNAME = "manager"
$env:HOTEL_ADMIN_PASSWORD = "replace-this-with-a-unique-password-of-at-least-12-characters"
npm start
```

Open the booking page at <http://127.0.0.1:3000/> and the manager dashboard at <http://127.0.0.1:3000/admin.html>. Sign in with the configured username and password. Keep the terminal running while using the site; opening the HTML files directly with `file://` will not submit bookings.

If port 3000 is already occupied, set `$env:PORT = "3001"` before `npm start`, then use <http://127.0.0.1:3001/> and <http://127.0.0.1:3001/admin.html>. Always open the site from the same server process that handles `/api/bookings`.

Valid requests are saved in `data/bookings.json` and remain available after restarting the server. The data directory is excluded from version control. The server listens on `127.0.0.1`, so the manager dashboard is only available on the same computer; it is not configured for public or multi-device access.

Run the tests with:

```powershell
npm test
```

## Room inventory and pricing

Room types, nightly rates, room counts, and per-room guest limits live in `rooms.js` — edit that file to change prices or inventory. The rooms page, booking form, and dashboard all read prices from the server, so there is a single source of truth.

Availability is checked per night when a booking request is created and again when the manager confirms it. Confirming fails with HTTP 409 if every room of that type is already held for the requested dates; reject the overlapping request first or ask the guest for new dates.

## Notifications (optional)

Set `HOTEL_NOTIFY_WEBHOOK_URL` to receive a JSON `POST` for each `booking.created`, `booking.confirmed`, and `booking.rejected` event. Point it at a service such as Zapier, Make, or n8n to forward events to email or SMS. Without this variable, events are only logged to the server console.

## API summary

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/rooms` | Public | Room types with rates, counts, and guest limits |
| `POST` | `/api/bookings` | Public | Create a booking request (validated, availability-checked, priced) |
| `GET` | `/api/bookings?status=&search=` | Manager | List bookings, optionally filtered |
| `PATCH` | `/api/bookings/:id` | Manager | Update status; confirming re-checks availability |
| `POST` | `/api/login` | Public | Manager sign in |
| `POST` | `/api/logout` | Public | Manager sign out |
| `GET` | `/api/session` | Public | Whether a manager session is active |
