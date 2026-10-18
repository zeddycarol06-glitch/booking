import test from "node:test";
import assert from "node:assert/strict";
import { validateBooking } from "../validation.js";

const validBooking = {
    name: "Jamie Guest",
    email: "jamie@example.com",
    phone: "+254700123456",
    roomType: "Standard Room",
    checkIn: "2027-06-10",
    checkOut: "2027-06-12",
    guests: "2"
};

test("accepts valid booking details and normalizes email and guest count", () => {
    const result = validateBooking(validBooking, "2027-01-01");
    assert.equal(result.valid, true);
    assert.equal(result.booking.email, "jamie@example.com");
    assert.equal(result.booking.guests, 2);
});

test("rejects invalid calendar dates and checkout before check-in", () => {
    assert.equal(validateBooking({ ...validBooking, checkIn: "2027-02-30" }, "2027-01-01").valid, false);
    assert.equal(validateBooking({ ...validBooking, checkOut: "2027-06-10" }, "2027-01-01").valid, false);
});

test("rejects past dates, invalid room choices, and out-of-range guest counts", () => {
    assert.equal(validateBooking(validBooking, "2027-06-11").valid, false);
    assert.equal(validateBooking({ ...validBooking, roomType: "Penthouse" }, "2027-01-01").valid, false);
    assert.equal(validateBooking({ ...validBooking, guests: "11" }, "2027-01-01").valid, false);
});
