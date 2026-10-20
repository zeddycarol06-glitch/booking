import { CURRENCY } from "./rooms.js";

export const PRICING_RULES = {
    weekend: {
        enabled: true,
        days: [5, 6],
        multiplier: 1.2,
        label: "Weekend rate"
    },
    festive: {
        enabled: true,
        ranges: [{ from: "2026-12-15", to: "2027-01-05" }],
        multiplier: 1.4,
        label: "Festive season"
    },
    longStay: {
        enabled: true,
        tiers: [
            { minNights: 14, discount: 0.15, label: "14+ nights" },
            { minNights: 7, discount: 0.1, label: "7+ nights" }
        ]
    }
};

export const DEPOSIT_PERCENT = clampPercent(Number(process.env.HOTEL_DEPOSIT_PERCENT));

export function clampPercent(value) {
    if (!Number.isFinite(value) || value <= 0) return 20;
    return Math.min(100, value);
}

function dateParts(dateString) {
    return new Date(`${dateString}T00:00:00.000Z`);
}

function eachNight(checkIn, checkOut) {
    const nights = [];
    const cursor = dateParts(checkIn);
    const end = dateParts(checkOut);
    while (cursor < end) {
        nights.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return nights;
}

function inRange(night, { from, to }) {
    return night >= from && night <= to;
}

function festiveMultiplier(night) {
    if (!PRICING_RULES.festive.enabled) return null;
    const match = PRICING_RULES.festive.ranges.find((range) => inRange(night, range));
    return match ? PRICING_RULES.festive.multiplier : null;
}

function longStayTier(nights) {
    if (!PRICING_RULES.longStay.enabled) return null;
    return PRICING_RULES.longStay.tiers.find((tier) => nights >= tier.minNights) || null;
}

export function roundUpToHundred(amount) {
    return Math.ceil(amount / 100) * 100;
}

export function buildQuote(room, checkIn, checkOut) {
    const nights = eachNight(checkIn, checkOut);
    const nightlyRates = nights.map((night) => {
        const reasons = [];
        let rate = room.nightlyRate;

        const festive = festiveMultiplier(night);
        if (festive) {
            rate *= festive;
            reasons.push(PRICING_RULES.festive.label);
        }

        if (PRICING_RULES.weekend.enabled && PRICING_RULES.weekend.days.includes(dateParts(night).getUTCDay())) {
            rate *= PRICING_RULES.weekend.multiplier;
            reasons.push(PRICING_RULES.weekend.label);
        }

        rate = Math.round(rate);
        return { night, rate, reasons };
    });

    const baseTotal = nights.length * room.nightlyRate;
    const subtotal = nightlyRates.reduce((sum, entry) => sum + entry.rate, 0);
    const tier = longStayTier(nights.length);
    const discount = tier ? Math.round(subtotal * tier.discount) : 0;
    const totalPrice = subtotal - discount;
    const depositDue = roundUpToHundred((totalPrice * DEPOSIT_PERCENT) / 100);

    return {
        nights: nights.length,
        baseNightlyRate: room.nightlyRate,
        nightlyRates,
        baseTotal,
        subtotal,
        adjustments: subtotal - baseTotal,
        discount,
        discountLabel: tier ? tier.label : null,
        totalPrice,
        depositPercent: DEPOSIT_PERCENT,
        depositDue,
        currency: CURRENCY
    };
}

export function quoteFromNights(room, nights) {
    if (!nights || nights < 1) {
        return {
            nights: 0,
            nightlyRate: room.nightlyRate,
            totalPrice: 0,
            depositDue: 0,
            currency: CURRENCY
        };
    }
    const checkIn = "2000-01-01";
    const end = dateParts(checkIn);
    end.setUTCDate(end.getUTCDate() + nights);
    const checkOut = end.toISOString().slice(0, 10);
    const quote = buildQuote(room, checkIn, checkOut);
    return {
        nights: quote.nights,
        nightlyRate: Math.round(quote.totalPrice / quote.nights),
        totalPrice: quote.totalPrice,
        depositDue: quote.depositDue,
        currency: quote.currency
    };
}
