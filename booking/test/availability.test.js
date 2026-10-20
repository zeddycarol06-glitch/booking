import test from "node:test";
import assert from "node:assert/strict";
import { checkAvailability } from "../availability.js";

function makeBooking(overrides = {}) {
    return {
        id: "11111111-1111-1111-1111-111111111111",
        roomType: "Standard Room",
        checkIn: "2027-06-10",
        checkOut: "2027-06-12",
        status: "confirmed",
        ...overrides
    };
}

test("reports full availability when no bookings exist", () => {
    const result = checkAvailability("Standard Room", "2027-06-10", "2027-06-12", []);
    assert.equal(result.available, true);
    assert.equal(result.remaining, 5);
});

test("rejects unknown room types", () => {
    const result = checkAvailability("Penthouse", "2027-06-10", "2027-06-12", []);
    assert.equal(result.available, false);
    assert.match(result.error, /room types/);
});

test("counts overlapping pending and confirmed bookings, but not rejected ones", () => {
    const bookings = [
        makeBooking({ id: "11111111-1111-1111-1111-111111111111" }),
        makeBooking({ id: "22222222-2222-2222-2222-222222222222", status: "pending", checkIn: "2027-06-11", checkOut: "2027-06-13" }),
        makeBooking({ id: "33333333-3333-3333-3333-333333333333", status: "rejected", checkIn: "2027-06-10", checkOut: "2027-06-12" })
    ];
    const result = checkAvailability("Standard Room", "2027-06-10", "2027-06-12", bookings);
    assert.equal(result.available, true);
    assert.equal(result.remaining, 3);
});

test("blocks the last room when inventory is exhausted", () => {
    const bookings = Array.from({ length: 5 }, (_, index) => makeBooking({
        id: `${String(index + 1).padStart(8, "0")}-1111-1111-1111-111111111111`
    }));
    const result = checkAvailability("Standard Room", "2027-06-10", "2027-06-12", bookings);
    assert.equal(result.available, false);
    assert.equal(result.remaining, 0);
});

test("allows back-to-back stays on the same turnover day", () => {
    const bookings = [makeBooking({ checkIn: "2027-06-08", checkOut: "2027-06-10" })];
    const result = checkAvailability("Standard Room", "2027-06-10", "2027-06-12", bookings);
    assert.equal(result.available, true);
});

test("excludeId releases the booking's own hold when re-checking on confirm", () => {
    const booking = makeBooking();
    const others = Array.from({ length: 4 }, (_, index) => makeBooking({
        id: `${String(index + 4).padStart(8, "0")}-1111-1111-1111-111111111111`
    }));
    const bookings = [...others, booking];

    const blocked = checkAvailability("Standard Room", booking.checkIn, booking.checkOut, bookings);
    assert.equal(blocked.available, false);

    const excluded = checkAvailability("Standard Room", booking.checkIn, booking.checkOut, bookings, booking.id);
    assert.equal(excluded.available, true);
    assert.equal(excluded.remaining, 1);
});

test("only overlaps of the same room type count against inventory", () => {
    const bookings = [
        makeBooking({ roomType: "Deluxe Room" }),
        makeBooking({ roomType: "Luxury Suite" })
    ];
    const result = checkAvailability("Standard Room", "2027-06-10", "2027-06-12", bookings);
    assert.equal(result.remaining, 5);
});
