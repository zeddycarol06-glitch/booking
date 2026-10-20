import { formatMoney } from "./rooms.js";

const WEBHOOK_URL = process.env.HOTEL_NOTIFY_WEBHOOK_URL || "";
const WEBHOOK_TIMEOUT_MS = 5000;

function describe(event, booking) {
    const stay = `${booking.checkIn} to ${booking.checkOut}`;
    const price = booking.totalPrice != null ? ` (${formatMoney(booking.totalPrice)})` : "";
    return `${event}: booking ${booking.id} — ${booking.name} <${booking.email}>, ${booking.roomType}, ${stay}${price}`;
}

export async function notifyBookingEvent(event, booking) {
    console.log(`[notify] ${describe(event, booking)}`);
    if (!WEBHOOK_URL) return;

    try {
        const response = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ event, hotel: "Dream Hotel", booking }),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS)
        });
        if (!response.ok) {
            console.error(`[notify] Webhook responded with HTTP ${response.status}.`);
        }
    } catch (error) {
        console.error(`[notify] Webhook failed: ${error.message}`);
    }
}

export function notifyAsync(event, booking) {
    void notifyBookingEvent(event, booking);
}
