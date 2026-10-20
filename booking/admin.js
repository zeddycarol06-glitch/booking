const loginPanel = document.querySelector("#login-panel");
const dashboardPanel = document.querySelector("#dashboard-panel");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const dashboardMessage = document.querySelector("#dashboard-message");
const bookingList = document.querySelector("#booking-list");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#booking-search");
const statusFilter = document.querySelector("#status-filter");

let searchTimer;
let calendarFrom = new Date().toISOString().slice(0, 10);

async function readApiResponse(response) {
    const text = await response.text();
    let result;
    try {
        result = JSON.parse(text);
    } catch {
        throw new Error(`The server returned an invalid response (HTTP ${response.status}). Open the dashboard from the Dream Hotel server.`);
    }

    return result;
}

function setMessage(element, text, isError = false) {
    element.textContent = text;
    element.classList.toggle("is-error", isError);
}

async function request(url, options = {}) {
    const response = await fetch(url, options);
    const result = await readApiResponse(response);
    if (!response.ok) {
        if (response.status === 401) {
            loginPanel.hidden = false;
            dashboardPanel.hidden = true;
        }
        throw new Error(result.error || "The request could not be completed.");
    }
    return result;
}

function makeCell(text) {
    const cell = document.createElement("td");
    cell.textContent = text;
    return cell;
}

function formatMoney(amount) {
    return `KSh ${Number(amount).toLocaleString("en-US")}`;
}

function bookingPrice(booking) {
    if (booking.totalPrice != null) return formatMoney(booking.totalPrice);
    if (booking.nightlyRate != null && booking.checkIn && booking.checkOut) {
        const nights = Math.round(
            (new Date(`${booking.checkOut}T00:00:00.000Z`) - new Date(`${booking.checkIn}T00:00:00.000Z`)) / 86_400_000
        );
        if (Number.isFinite(nights) && nights > 0) return formatMoney(nights * booking.nightlyRate);
    }
    return "—";
}

function renderBookings(bookings) {
    bookingList.replaceChildren();
    emptyState.hidden = bookings.length !== 0;

    for (const booking of bookings) {
        const row = document.createElement("tr");
        const guestCell = document.createElement("td");
        const guestName = document.createElement("strong");
        guestName.textContent = booking.name;
        const guestEmail = document.createElement("a");
        guestEmail.href = `mailto:${booking.email}`;
        guestEmail.textContent = booking.email;
        const guestPhone = document.createElement("span");
        guestPhone.textContent = booking.phone;
        guestCell.append(guestName, guestEmail, guestPhone);
        row.append(guestCell);
        row.append(makeCell(booking.roomType));

        const nights = booking.nights != null
            ? booking.nights
            : Math.round((new Date(`${booking.checkOut}T00:00:00.000Z`) - new Date(`${booking.checkIn}T00:00:00.000Z`)) / 86_400_000);
        row.append(makeCell(`${booking.checkIn} to ${booking.checkOut} (${nights} night${nights === 1 ? "" : "s"})`));
        row.append(makeCell(String(booking.guests)));

        const totalCell = makeCell(bookingPrice(booking));
        totalCell.className = "booking-total";
        row.append(totalCell);
        row.append(makeCell(new Date(booking.createdAt).toLocaleString()));

        const statusCell = document.createElement("td");
        const status = document.createElement("span");
        status.className = `status-badge status-${booking.status}`;
        status.textContent = booking.status;
        statusCell.append(status);
        if (booking.payment && booking.payment.state && booking.payment.state !== "not_required") {
            const pay = document.createElement("span");
            pay.className = `pay-badge pay-${booking.payment.state}`;
            const labels = { paid: "Paid", required: "Unpaid", prompted: "Awaiting", failed: "Failed" };
            pay.textContent = `${labels[booking.payment.state] || booking.payment.state} ${formatMoney(booking.payment.amount)}`;
            statusCell.append(pay);
        }
        row.append(statusCell);

        const actionCell = document.createElement("td");
        const statusSelect = document.createElement("select");
        statusSelect.setAttribute("aria-label", `Update booking status for ${booking.name}`);
        for (const value of ["pending", "confirmed", "rejected", "cancelled"]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
            option.selected = value === booking.status;
            statusSelect.append(option);
        }
        statusSelect.addEventListener("change", async () => {
            statusSelect.disabled = true;
            try {
                await request(`/api/bookings/${encodeURIComponent(booking.id)}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: statusSelect.value })
                });
                setMessage(dashboardMessage, `Booking ${booking.id.slice(0, 8)} marked ${statusSelect.value}.`);
                await loadBookings();
            } catch (error) {
                setMessage(dashboardMessage, error.message, true);
                statusSelect.value = booking.status;
                statusSelect.disabled = false;
            }
        });
        actionCell.append(statusSelect);
        row.append(actionCell);
        bookingList.append(row);
    }
}

function currentFilters() {
    const params = new URLSearchParams();
    const search = searchInput.value.trim();
    if (search) params.set("search", search);
    if (statusFilter.value) params.set("status", statusFilter.value);
    const query = params.toString();
    return query ? `?${query}` : "";
}

function updateStats(counts) {
    const targets = {
        total: "stat-total",
        pending: "stat-pending",
        confirmed: "stat-confirmed",
        rejected: "stat-rejected",
        cancelled: "stat-cancelled"
    };
    for (const [key, id] of Object.entries(targets)) {
        const element = document.getElementById(id);
        if (element) element.textContent = String(counts?.[key] ?? 0);
    }
}

async function loadBookings() {
    const data = await request(`/api/bookings${currentFilters()}`);
    renderBookings(data.bookings);
    updateStats(data.counts);
}

async function checkSession() {
    try {
        const { authenticated } = await request("/api/session");
        if (!authenticated) return;
        loginPanel.hidden = true;
        dashboardPanel.hidden = false;
        await loadBookings();
    } catch (error) {
        if (error.message !== "Sign in is required.") {
            setMessage(loginMessage, error.message, true);
        }
    }
}

searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        loadBookings().catch((error) => setMessage(dashboardMessage, error.message, true));
    }, 250);
});

statusFilter.addEventListener("change", () => {
    loadBookings().catch((error) => setMessage(dashboardMessage, error.message, true));
});

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage(loginMessage, "Signing in...");
    const credentials = Object.fromEntries(new FormData(loginForm));
    try {
        await request("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(credentials)
        });
        loginForm.reset();
        loginPanel.hidden = true;
        dashboardPanel.hidden = false;
        setMessage(loginMessage, "");
        await loadBookings();
    } catch (error) {
        setMessage(loginMessage, error.message, true);
    }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
    try {
        await request("/api/logout", { method: "POST" });
        dashboardPanel.hidden = true;
        loginPanel.hidden = false;
        setMessage(loginMessage, "You have signed out.");
    } catch (error) {
        setMessage(dashboardMessage, error.message, true);
    }
});

function addDays(dateString, days) {
    const date = new Date(`${dateString}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function shortDate(dateString) {
    return new Date(`${dateString}T00:00:00.000Z`).toLocaleDateString("en-US", {
        weekday: "short", day: "numeric", month: "short", timeZone: "UTC"
    });
}

function renderCalendar(data) {
    const from = data.from;
    const to = data.to;
    document.querySelector("#calendar-range").textContent = `${shortDate(from)} — ${shortDate(to)}`;
    const table = document.querySelector("#calendar-table");
    table.replaceChildren();

    const dates = data.roomTypes[0]?.days.map((day) => day.date) || [];
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.append(document.createElement("th"));
    for (const date of dates) {
        const th = document.createElement("th");
        th.textContent = shortDate(date).replace(", ", " ");
        headRow.append(th);
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    for (const room of data.roomTypes) {
        const row = document.createElement("tr");
        const label = document.createElement("th");
        label.scope = "row";
        label.textContent = `${room.roomType} (${room.totalRooms})`;
        row.append(label);
        for (const day of room.days) {
            const cell = document.createElement("td");
            const full = day.occupied >= room.totalRooms;
            const partial = day.occupied > 0 && !full;
            cell.className = `calendar-cell ${full ? "is-full" : partial ? "is-partial" : "is-free"}`;
            cell.textContent = `${day.occupied}/${room.totalRooms}`;
            cell.title = day.guests.length
                ? day.guests.map((guest) => `${guest.name} (${guest.status})`).join("\n")
                : "Available";
            row.append(cell);
        }
        body.append(row);
    }
    table.append(body);
}

async function loadCalendar() {
    const to = addDays(calendarFrom, 13);
    const data = await request(`/api/occupancy?from=${calendarFrom}&to=${to}`);
    renderCalendar(data);
}

const tabBookings = document.querySelector("#tab-bookings");
const tabOccupancy = document.querySelector("#tab-occupancy");
const bookingsPanel = document.querySelector("#bookings-panel");
const occupancyPanel = document.querySelector("#occupancy-panel");

function selectTab(which) {
    const showBookings = which === "bookings";
    tabBookings.classList.toggle("is-active", showBookings);
    tabOccupancy.classList.toggle("is-active", !showBookings);
    tabBookings.setAttribute("aria-selected", String(showBookings));
    tabOccupancy.setAttribute("aria-selected", String(!showBookings));
    bookingsPanel.hidden = !showBookings;
    occupancyPanel.hidden = showBookings;
    if (!showBookings) {
        loadCalendar().catch((error) => setMessage(dashboardMessage, error.message, true));
    }
}

tabBookings.addEventListener("click", () => selectTab("bookings"));
tabOccupancy.addEventListener("click", () => selectTab("occupancy"));
document.querySelector("#calendar-prev").addEventListener("click", () => {
    calendarFrom = addDays(calendarFrom, -7);
    loadCalendar().catch((error) => setMessage(dashboardMessage, error.message, true));
});
document.querySelector("#calendar-next").addEventListener("click", () => {
    calendarFrom = addDays(calendarFrom, 7);
    loadCalendar().catch((error) => setMessage(dashboardMessage, error.message, true));
});
document.querySelector("#calendar-today").addEventListener("click", () => {
    calendarFrom = new Date().toISOString().slice(0, 10);
    loadCalendar().catch((error) => setMessage(dashboardMessage, error.message, true));
});
checkSession();
