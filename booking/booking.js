const form = document.querySelector("#booking-form");
const message = document.querySelector("#booking-message");
const bookingToggle = document.querySelector("#booking-toggle");
const bookingDetails = document.querySelector("#booking-details");
const checkInInput = document.querySelector("#check-in");
const checkOutInput = document.querySelector("#check-out");
const roomSelect = document.querySelector("#room-type");
const guestsInput = document.querySelector("#guests");
const priceQuote = document.querySelector("#price-quote");
const submitButton = form.querySelector("button[type='submit']");
const heroBook = document.querySelector("#hero-book");

const today = new Date();
const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
const serverInstructions = "Start the Dream Hotel server with npm start, then open http://127.0.0.1:3000/. If port 3000 is already in use, restart with $env:PORT = \"3001\" and open http://127.0.0.1:3001/.";
const DEFAULT_GUESTS_MAX = 10;

let roomCatalog = [];
let quoteTimer;

function formatMoney(amount) {
    return `KSh ${Number(amount).toLocaleString("en-US")}`;
}

function stayNights() {
    if (!checkInInput.value || !checkOutInput.value) return 0;
    const start = new Date(`${checkInInput.value}T00:00:00.000Z`);
    const end = new Date(`${checkOutInput.value}T00:00:00.000Z`);
    const nights = Math.round((end - start) / 86_400_000);
    return Number.isFinite(nights) && nights > 0 ? nights : 0;
}

function selectedRoom() {
    return roomCatalog.find((room) => room.name === roomSelect.value) || null;
}

function updateGuestLimit() {
    const room = selectedRoom();
    guestsInput.max = room ? String(room.maxGuests) : String(DEFAULT_GUESTS_MAX);
    if (room && Number(guestsInput.value) > room.maxGuests) {
        guestsInput.value = String(room.maxGuests);
    }
}

function renderQuote(quote) {
    const parts = [`${quote.nights} night${quote.nights === 1 ? "" : "s"} × ${formatMoney(quote.baseNightlyRate)} = ${formatMoney(quote.baseTotal)}`];
    if (quote.adjustments) {
        parts.push(`Season/weekend +${formatMoney(quote.adjustments)}`);
    }
    if (quote.discount) {
        parts.push(`${quote.discountLabel} −${formatMoney(quote.discount)}`);
    }
    parts.push(`Total ${formatMoney(quote.totalPrice)}`);
    let text = parts.join(" · ");
    if (quote.depositDue) {
        text += ` · Deposit due ${formatMoney(quote.depositDue)} (${quote.depositPercent}%)`;
    }
    priceQuote.textContent = text;
    priceQuote.hidden = false;
}

function localQuote() {
    const room = selectedRoom();
    const nights = stayNights();
    if (!room || !nights) return null;
    return {
        nights,
        baseNightlyRate: room.nightlyRate,
        baseTotal: nights * room.nightlyRate,
        adjustments: 0,
        discount: 0,
        discountLabel: null,
        totalPrice: nights * room.nightlyRate,
        depositDue: 0,
        depositPercent: 0
    };
}

async function updateQuote() {
    const room = selectedRoom();
    const nights = stayNights();
    if (!room || !nights) {
        priceQuote.hidden = true;
        priceQuote.textContent = "";
        return;
    }
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
        const params = new URLSearchParams({
            roomType: roomSelect.value,
            checkIn: checkInInput.value,
            checkOut: checkOutInput.value
        });
        try {
            const response = await fetch(`/api/quote?${params}`);
            if (!response.ok) throw new Error();
            const data = await response.json();
            renderQuote(data.quote);
        } catch {
            const fallback = localQuote();
            if (fallback) renderQuote(fallback);
        }
    }, 250);
}

async function loadRoomCatalog() {
    try {
        const response = await fetch("/api/rooms");
        if (!response.ok) return;
        const data = await response.json();
        if (!Array.isArray(data.rooms) || data.rooms.length === 0) return;
        roomCatalog = data.rooms;
        for (const option of roomSelect.options) {
            const room = roomCatalog.find((entry) => entry.name === option.value);
            if (room) {
                option.textContent = `${room.name} — ${formatMoney(room.nightlyRate)}/night`;
            }
        }
        updateGuestLimit();
        updateQuote();
    } catch {
        // Keep the static labels when the catalog cannot be loaded.
    }
}

bookingToggle.addEventListener("click", () => {
    const isExpanded = bookingToggle.getAttribute("aria-expanded") === "true";
    bookingToggle.setAttribute("aria-expanded", String(!isExpanded));
    bookingDetails.hidden = isExpanded;

    if (!isExpanded) {
        document.querySelector("#guest-name").focus();
    }
});

if (heroBook) {
    heroBook.addEventListener("click", (event) => {
        event.preventDefault();
        if (bookingDetails.hidden) {
            bookingToggle.setAttribute("aria-expanded", "true");
            bookingDetails.hidden = false;
        }
        bookingDetails.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => document.querySelector("#guest-name").focus({ preventScroll: true }), 400);
    });
}

async function readApiResponse(response) {
    const text = await response.text();
    let result;
    try {
        result = JSON.parse(text);
    } catch {
        throw new Error(`The booking server returned an invalid response (HTTP ${response.status}). ${serverInstructions}`);
    }

    if (!response.ok) {
        throw new Error(result.error || `The booking server returned HTTP ${response.status}.`);
    }
    return result;
}

checkInInput.min = localToday;
checkOutInput.min = localToday;

checkInInput.addEventListener("change", () => {
    checkOutInput.min = checkInInput.value || localToday;
    if (checkOutInput.value && checkOutInput.value <= checkInInput.value) {
        checkOutInput.value = "";
    }
    updateQuote();
});

checkOutInput.addEventListener("change", updateQuote);
roomSelect.addEventListener("change", () => {
    updateGuestLimit();
    updateQuote();
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "Submitting your request...";
    message.classList.remove("is-error", "is-success");
    submitButton.disabled = true;
    submitButton.classList.add("is-loading");

    const booking = Object.fromEntries(new FormData(form));
    try {
        const response = await fetch("/api/bookings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(booking)
        });
        const result = await readApiResponse(response);
        if (!result.booking?.id) {
            throw new Error(`The booking server did not confirm the request. ${serverInstructions}`);
        }

        form.reset();
        checkInInput.min = localToday;
        checkOutInput.min = localToday;
        updateGuestLimit();
        updateQuote();
        const priceSummary = result.booking.totalPrice != null
            ? ` Total: ${formatMoney(result.booking.totalPrice)} for ${result.booking.nights} night${result.booking.nights === 1 ? "" : "s"}.`
            : "";
        const depositSummary = result.paymentRequired && result.booking.depositDue
            ? ` Pay your ${formatMoney(result.booking.depositDue)} M-Pesa deposit here: track.html?reference=${encodeURIComponent(result.booking.id)}`
            : "";
        message.textContent = `Your request was received. Reference: ${result.booking.id}.${priceSummary}${depositSummary}`;
        message.classList.add("is-success");
    } catch (error) {
        if (window.location.protocol === "file:") {
            message.textContent = `This page was opened directly from a file. ${serverInstructions}`;
        } else if (error instanceof TypeError) {
            message.textContent = `Could not reach the booking server. ${serverInstructions}`;
        } else {
            message.textContent = error.message;
        }
        message.classList.remove("is-success");
        message.classList.add("is-error");
    } finally {
        submitButton.disabled = false;
        submitButton.classList.remove("is-loading");
    }
});

loadRoomCatalog();
