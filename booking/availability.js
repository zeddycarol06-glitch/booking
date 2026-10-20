import { getRoomType } from "./rooms.js";

const HOLDING_STATUSES = new Set(["pending", "confirmed"]);

function eachNight(checkIn, checkOut) {
    const nights = [];
    const cursor = new Date(`${checkIn}T00:00:00.000Z`);
    const end = new Date(`${checkOut}T00:00:00.000Z`);
    while (cursor < end) {
        nights.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return nights;
}

export function checkAvailability(roomType, checkIn, checkOut, bookings, excludeId = null) {
    const room = getRoomType(roomType);
    if (!room) {
        return { available: false, remaining: 0, totalRooms: 0, error: "Choose one of the available room types." };
    }

    let maxOccupancy = 0;
    for (const night of eachNight(checkIn, checkOut)) {
        const occupied = bookings.filter((booking) =>
            booking.id !== excludeId &&
            booking.roomType === roomType &&
            HOLDING_STATUSES.has(booking.status) &&
            booking.checkIn <= night &&
            night < booking.checkOut
        ).length;
        if (occupied > maxOccupancy) maxOccupancy = occupied;
    }

    const remaining = Math.max(0, room.totalRooms - maxOccupancy);
    return { available: remaining > 0, remaining, totalRooms: room.totalRooms };
}
