# Dream Hotel booking app

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

Run the booking validation tests with:

```powershell
npm test
```
