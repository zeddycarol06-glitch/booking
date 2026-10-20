import test from "node:test";
import assert from "node:assert/strict";
import { buildQuote, roundUpToHundred, PRICING_RULES } from "../pricing.js";
import { getRoomType } from "../rooms.js";

const standard = getRoomType("Standard Room");

test("rounds deposit up to the nearest hundred", () => {
    assert.equal(roundUpToHundred(0), 0);
    assert.equal(roundUpToHundred(1), 100);
    assert.equal(roundUpToHundred(100), 100);
    assert.equal(roundUpToHundred(101), 200);
    assert.equal(roundUpToHundred(3450), 3500);
});

test("charges the base rate for ordinary weekday nights", () => {
    const quote = buildQuote(standard, "2026-03-02", "2026-03-04");
    assert.equal(quote.nights, 2);
    assert.equal(quote.baseNightlyRate, 3000);
    assert.equal(quote.subtotal, 6000);
    assert.equal(quote.adjustments, 0);
    assert.equal(quote.totalPrice, 6000);
});

test("applies the weekend multiplier on Friday and Saturday nights", () => {
    const quote = buildQuote(standard, "2026-03-06", "2026-03-08");
    assert.equal(quote.nights, 2);
    assert.equal(quote.nightlyRates[0].night, "2026-03-06");
    assert.equal(quote.nightlyRates[0].rate, 3600);
    assert.ok(quote.nightlyRates[0].reasons.includes("Weekend rate"));
    assert.ok(quote.nightlyRates[1].reasons.includes("Weekend rate"));
    assert.equal(quote.subtotal, 7200);
});

test("applies the festive multiplier inside the festive window", () => {
    const quote = buildQuote(standard, "2026-12-24", "2026-12-26");
    assert.equal(quote.nightlyRates[0].rate, 4200);
    assert.ok(quote.nightlyRates[0].reasons.includes("Festive season"));
});

test("stacks festive and weekend multipliers", () => {
    const quote = buildQuote(standard, "2026-12-25", "2026-12-26");
    assert.equal(quote.nightlyRates[0].rate, Math.round(3000 * 1.4 * 1.2));
    assert.equal(quote.nightlyRates[0].reasons.length, 2);
});

test("ignores weekend pricing outside the configured days", () => {
    const quote = buildQuote(standard, "2026-03-02", "2026-03-03");
    assert.equal(quote.nightlyRates[0].reasons.length, 0);
    assert.equal(quote.nightlyRates[0].rate, 3000);
});

test("applies the 7+ night discount to the longest stay tier", () => {
    const quote = buildQuote(standard, "2026-03-02", "2026-03-10");
    assert.equal(quote.nights, 8);
    assert.equal(quote.discountLabel, "7+ nights");
    assert.equal(quote.discount, Math.round(quote.subtotal * 0.1));
    assert.equal(quote.totalPrice, quote.subtotal - quote.discount);
});

test("applies the 14+ night discount instead of the 7+ tier", () => {
    const quote = buildQuote(standard, "2026-03-02", "2026-03-17");
    assert.equal(quote.nights, 15);
    assert.equal(quote.discountLabel, "14+ nights");
    assert.equal(quote.discount, Math.round(quote.subtotal * 0.15));
});

test("computes the deposit as a rounded percentage of the total", () => {
    const quote = buildQuote(standard, "2026-03-02", "2026-03-04");
    assert.equal(quote.depositPercent, 20);
    assert.equal(quote.depositDue, roundUpToHundred(6000 * 0.2));
});

test("handles stays that cross a month boundary", () => {
    const quote = buildQuote(standard, "2026-03-30", "2026-04-02");
    assert.equal(quote.nights, 3);
    assert.deepEqual(quote.nightlyRates.map((entry) => entry.night), ["2026-03-30", "2026-03-31", "2026-04-01"]);
});

test("exposes the pricing configuration for inspection", () => {
    assert.equal(PRICING_RULES.weekend.multiplier, 1.2);
    assert.equal(PRICING_RULES.festive.multiplier, 1.4);
    assert.equal(PRICING_RULES.longStay.tiers.length, 2);
});
