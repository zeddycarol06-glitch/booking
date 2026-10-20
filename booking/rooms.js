export const ROOM_TYPES = [
    { id: "standard", name: "Standard Room", nightlyRate: 3000, totalRooms: 5, maxGuests: 2 },
    { id: "deluxe", name: "Deluxe Room", nightlyRate: 5000, totalRooms: 3, maxGuests: 4 },
    { id: "luxury", name: "Luxury Suite", nightlyRate: 8000, totalRooms: 2, maxGuests: 6 }
];

export const CURRENCY = "KSh";

export function getRoomType(name) {
    return ROOM_TYPES.find((room) => room.name === name) || null;
}

export function nightsBetween(checkIn, checkOut) {
    const start = new Date(`${checkIn}T00:00:00.000Z`);
    const end = new Date(`${checkOut}T00:00:00.000Z`);
    return Math.round((end - start) / 86_400_000);
}

export function quoteStay(room, nights) {
    return {
        nights,
        nightlyRate: room.nightlyRate,
        totalPrice: nights * room.nightlyRate,
        currency: CURRENCY
    };
}

export function formatMoney(amount) {
    return `${CURRENCY} ${Number(amount).toLocaleString("en-US")}`;
}
