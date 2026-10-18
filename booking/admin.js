const loginPanel = document.querySelector("#login-panel");
const dashboardPanel = document.querySelector("#dashboard-panel");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const dashboardMessage = document.querySelector("#dashboard-message");
const bookingList = document.querySelector("#booking-list");
const emptyState = document.querySelector("#empty-state");

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
        row.append(makeCell(`${booking.checkIn} to ${booking.checkOut}`));
        row.append(makeCell(String(booking.guests)));
        row.append(makeCell(new Date(booking.createdAt).toLocaleString()));

        const statusCell = document.createElement("td");
        const status = document.createElement("span");
        status.className = `status-badge status-${booking.status}`;
        status.textContent = booking.status;
        statusCell.append(status);
        row.append(statusCell);

        const actionCell = document.createElement("td");
        const statusSelect = document.createElement("select");
        statusSelect.setAttribute("aria-label", `Update booking status for ${booking.name}`);
        for (const value of ["pending", "confirmed", "rejected"]) {
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
                setMessage(dashboardMessage, "Booking status updated.");
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

async function loadBookings() {
    const { bookings } = await request("/api/bookings");
    renderBookings(bookings);
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

checkSession();
