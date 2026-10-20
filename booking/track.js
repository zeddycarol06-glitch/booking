const form = document.querySelector("#track-form");
const message = document.querySelector("#track-message");
const result = document.querySelector("#track-result");
const paymentPanel = document.querySelector("#payment-panel");
const paymentStatus = document.querySelector("#payment-status");
const payButton = document.querySelector("#pay-button");
const phoneInput = document.querySelector("#payment-phone");
const cancelButton = document.querySelector("#cancel-booking");

const referenceInput = document.querySelector("#track-reference");
const emailInput = document.querySelector("#track-email");
const params = new URLSearchParams(window.location.search);

let current = { reference: "", email: "" };
let pollTimer;

function formatMoney(amount) {
    return `KSh ${Number(amount || 0).toLocaleString("en-US")}`;
}

function setMessage(text, isError = false) {
    message.textContent = text;
    message.classList.toggle("is-error", isError);
    message.classList.toggle("is-success", !isError && Boolean(text));
}

async function request(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new Error(data.error || `The request failed (HTTP ${response.status}).`);
    return data;
}

function renderBooking(booking) {
    result.hidden = false;
    document.querySelector("#track-ref").textContent = booking.id;
    const badge = document.querySelector("#track-status");
    badge.className = `status-badge status-${booking.status}`;
    badge.textContent = booking.status;
    document.querySelector("#track-guest").textContent = booking.name;
    document.querySelector("#track-room").textContent = booking.roomType;
    const nights = booking.nights ?? 0;
    document.querySelector("#track-stay").textContent = `${booking.checkIn} to ${booking.checkOut} (${nights} night${nights === 1 ? "" : "s"})`;
    document.querySelector("#track-guests").textContent = String(booking.guests);
    document.querySelector("#track-total").textContent = formatMoney(booking.totalPrice);
    document.querySelector("#track-deposit").textContent = formatMoney(booking.depositDue);

    renderPayment(booking);

    const cancellable = ["pending", "confirmed"].includes(booking.status);
    cancelButton.hidden = !cancellable;
}

function renderPayment(booking) {
    const payment = booking.payment || {};
    const active = ["pending", "confirmed"].includes(booking.status);
    const payable = active && payment.state !== "paid" && payment.amount > 0;
    paymentPanel.hidden = !payable;

    const labels = {
        not_required: "No deposit required — the hotel will confirm your request.",
        required: `Deposit of ${formatMoney(payment.amount)} is due.`,
        prompted: "Waiting for you to enter your M-Pesa PIN...",
        paid: `Deposit paid${payment.receipt ? ` — receipt ${payment.receipt}` : ""}.`,
        failed: payment.message || "The deposit payment did not complete. Try again."
    };
    paymentStatus.textContent = labels[payment.state] || "";
    paymentStatus.classList.toggle("is-error", payment.state === "failed");
    payButton.disabled = payment.state === "prompted";
}

async function loadBooking() {
    const data = await request("/api/bookings/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(current)
    });
    renderBooking(data.booking);
    return data.booking;
}

function startPolling() {
    clearInterval(pollTimer);
    let attempts = 0;
    pollTimer = setInterval(async () => {
        attempts += 1;
        try {
            const data = await request(`/api/payments/${encodeURIComponent(current.reference)}/status`);
            renderBooking(data.booking);
            if (data.payment.state === "paid" || data.payment.state === "failed" || attempts >= 20) {
                clearInterval(pollTimer);
            }
        } catch {
            if (attempts >= 20) clearInterval(pollTimer);
        }
    }, 3000);
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    current = { reference: referenceInput.value.trim(), email: emailInput.value.trim() };
    setMessage("Looking up your booking...");
    try {
        await loadBooking();
        setMessage("");
    } catch (error) {
        result.hidden = true;
        setMessage(error.message, true);
    }
});

payButton.addEventListener("click", async () => {
    payButton.disabled = true;
    paymentStatus.textContent = "Sending the M-Pesa request...";
    paymentStatus.classList.remove("is-error");
    try {
        await request("/api/payments/stk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...current, phone: phoneInput.value.trim() })
        });
        paymentStatus.textContent = "Check your phone and enter your M-Pesa PIN.";
        paymentStatus.classList.remove("is-error");
        payButton.disabled = true;
        startPolling();
    } catch (error) {
        paymentStatus.textContent = error.message;
        paymentStatus.classList.add("is-error");
        payButton.disabled = false;
    }
});

cancelButton.addEventListener("click", async () => {
    if (!window.confirm("Cancel this booking? This cannot be undone.")) return;
    cancelButton.disabled = true;
    try {
        const data = await request("/api/bookings/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(current)
        });
        renderBooking(data.booking);
        setMessage("Your booking was cancelled.");
    } catch (error) {
        setMessage(error.message, true);
    } finally {
        cancelButton.disabled = false;
    }
});

if (params.get("reference")) {
    referenceInput.value = params.get("reference");
    if (params.get("email")) emailInput.value = params.get("email");
    referenceInput.focus();
}
