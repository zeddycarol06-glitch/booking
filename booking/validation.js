import { getRoomType } from "./rooms.js";

function isValidCalendarDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validateBooking(input, today = new Date().toISOString().slice(0, 10)) {    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return { valid: false, error: "Enter your booking details." };
    }

    const name = typeof input.name === "string" ? input.name.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    const roomType = typeof input.roomType === "string" ? input.roomType : "";
    const checkIn = typeof input.checkIn === "string" ? input.checkIn : "";
    const checkOut = typeof input.checkOut === "string" ? input.checkOut : "";
    const guests = Number(input.guests);
    const room = getRoomType(roomType);

    if (name.length < 2 || name.length > 100) {
        return { valid: false, error: "Enter a name between 2 and 100 characters." };
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { valid: false, error: "Enter a valid email address." };
    }
    if (phone.length < 7 || phone.length > 30) {
        return { valid: false, error: "Enter a valid phone number." };
    }
    if (!room) {
        return { valid: false, error: "Choose one of the available room types." };
    }
    if (!isValidCalendarDate(checkIn) || !isValidCalendarDate(checkOut) || checkIn < today || checkOut <= checkIn) {
        return { valid: false, error: "Choose valid dates, with check-out after check-in and no dates in the past." };
    }
    if (!Number.isInteger(guests) || guests < 1 || guests > room.maxGuests) {
        return { valid: false, error: `Choose between 1 and ${room.maxGuests} guests for a ${room.name}.` };
    }

    return {
        valid: true,
        booking: { name, email, phone, roomType, checkIn, checkOut, guests }
    };
}

export function validateStay(room, checkIn, checkOut, today = new Date().toISOString().slice(0, 10)) {
    if (!room) {
        return { valid: false, error: "Choose one of the available room types." };
    }
    if (!isValidCalendarDate(checkIn) || !isValidCalendarDate(checkOut) || checkIn < today || checkOut <= checkIn) {
        return { valid: false, error: "Choose valid dates, with check-out after check-in and no dates in the past." };
    }
    return { valid: true };
}
