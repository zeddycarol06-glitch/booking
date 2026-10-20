import test from "node:test";
import assert from "node:assert/strict";
import { getRoomType, nightsBetween, quoteStay, formatMoney } from "../rooms.js";

test("looks up room types by name", () => {
    assert.equal(getRoomType("Deluxe Room").nightlyRate, 5000);
    assert.equal(getRoomType("Penthouse"), null);
});

test("counts nights between check-in and check-out", () => {
    assert.equal(nightsBetween("2027-06-10", "2027-06-12"), 2);
    assert.equal(nightsBetween("2027-06-10", "2027-06-11"), 1);
});

test("quotes the stay from the room rate and night count", () => {
    const room = getRoomType("Standard Room");
    const quote = quoteStay(room, 3);
    assert.equal(quote.nightlyRate, 3000);
    assert.equal(quote.totalPrice, 9000);
    assert.equal(quote.currency, "KSh");
});

test("formats money in hotel currency", () => {
    assert.equal(formatMoney(9000), "KSh 9,000");
});
