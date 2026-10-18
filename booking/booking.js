const form = document.querySelector("#booking-form");
const message = document.querySelector("#booking-message");
const bookingToggle = document.querySelector("#booking-toggle");
const bookingDetails = document.querySelector("#booking-details");
const checkInInput = document.querySelector("#check-in");
const checkOutInput = document.querySelector("#check-out");

const today = new Date();
const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
const serverInstructions = "Start the Dream Hotel server with npm start, then open http://127.0.0.1:3000/. If port 3000 is already in use, restart with $env:PORT = \"3001\" and open http://127.0.0.1:3001/.";

bookingToggle.addEventListener("click", () => {
    const isExpanded = bookingToggle.getAttribute("aria-expanded") === "true";
    bookingToggle.setAttribute("aria-expanded", String(!isExpanded));
    bookingDetails.hidden = isExpanded;

    if (!isExpanded) {
        document.querySelector("#guest-name").focus();
    }
});

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
});

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "Submitting your request...";
    message.classList.remove("is-error");

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
        message.textContent = `Your request was received. Reference: ${result.booking.id}`;
    } catch (error) {
        if (window.location.protocol === "file:") {
            message.textContent = `This page was opened directly from a file. ${serverInstructions}`;
        } else if (error instanceof TypeError) {
            message.textContent = `Could not reach the booking server. ${serverInstructions}`;
        } else {
            message.textContent = error.message;
        }
        message.classList.add("is-error");
    }
});
