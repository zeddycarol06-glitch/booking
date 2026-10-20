import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    createHash,
    randomBytes,
    randomUUID,
    scrypt as scryptCallback,
    timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";
import { validateBooking, validateStay } from "./validation.js";
import { ROOM_TYPES, getRoomType } from "./rooms.js";
import { checkAvailability } from "./availability.js";
import { buildQuote } from "./pricing.js";
import { notifyAsync } from "./notify.js";
import {
    isPaymentConfigured,
    stkPush,
    stkQuery,
    parseCallback,
    normalizeMsisdn
} from "./mpesa.js";

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = "127.0.0.1";
const ADMIN_USERNAME = process.env.HOTEL_ADMIN_USERNAME || "manager";
const ADMIN_PASSWORD = process.env.HOTEL_ADMIN_PASSWORD || "";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE_NAME = "hotel_manager_session";
const MAX_BODY_BYTES = 16 * 1024;
const PRIVATE_DIRECTORY_OPTIONS = process.platform === "win32" ? {} : { mode: 0o700 };
const PRIVATE_FILE_OPTIONS = process.platform === "win32" ? {} : { mode: 0o600 };
const ALLOWED_STATUSES = new Set(["pending", "confirmed", "rejected", "cancelled"]);
const CANCELLATION_NOTICE_MS = 48 * 60 * 60 * 1000;
const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
};
const sessions = new Map();
const loginAttempts = new Map();
let bookings = [];
let writeQueue = Promise.resolve();
let passwordSalt;
let passwordVerifier;

function json(response, status, data, headers = {}) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers
    });
    response.end(JSON.stringify(data));
}

function parseCookies(header = "") {
    return Object.fromEntries(header.split(";").map((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return ["", ""];
        return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    }).filter(([key]) => key));
}

function getSession(request) {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { token, session };
}

function requireSession(request, response) {
    if (!getSession(request)) {
        json(response, 401, { error: "Sign in is required." });
        return false;
    }
    return true;
}

function sendSessionCookie(response, token, request) {
    const secure = Boolean(request.socket.encrypted);
    response.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`);
}

async function readJson(request) {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        const error = new Error("Send request data as JSON.");
        error.statusCode = 415;
        throw error;
    }

    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const error = new Error("Request is too large.");
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        const error = new Error("Request body must contain valid JSON.");
        error.statusCode = 400;
        throw error;
    }
}

async function updateBookings(transform) {
    let updatedBookings;
    writeQueue = writeQueue.catch(() => {}).then(async () => {
        updatedBookings = transform(bookings);
        if (updatedBookings === null) return;
        const temporaryFile = `${BOOKINGS_FILE}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporaryFile, JSON.stringify(updatedBookings, null, 2), PRIVATE_FILE_OPTIONS);
            await fs.rename(temporaryFile, BOOKINGS_FILE);
        } finally {
            await fs.rm(temporaryFile, { force: true });
        }
        bookings = updatedBookings;
    });
    await writeQueue;
    return updatedBookings;
}

function loginIsLimited(ip) {
    const record = loginAttempts.get(ip);
    if (!record) return false;
    if (record.resetAt <= Date.now()) {
        loginAttempts.delete(ip);
        return false;
    }
    return record.count >= 5;
}

function recordFailedLogin(ip) {
    const record = loginAttempts.get(ip);
    if (!record || record.resetAt <= Date.now()) {
        loginAttempts.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
    } else {
        record.count += 1;
    }
}

function loginRetryAfter(ip) {
    const record = loginAttempts.get(ip);
    return Math.max(1, Math.ceil((record.resetAt - Date.now()) / 1000));
}

function sendStaticFile(request, response, pathname) {
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(pathname);
    } catch {
        json(response, 400, { error: "Invalid URL path." });
        return;
    }
    const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
    const filePath = path.resolve(ROOT, relativePath);
    if (!filePath.startsWith(`${ROOT}${path.sep}`) || filePath.startsWith(`${DATA_DIR}${path.sep}`)) {
        json(response, 404, { error: "Not found." });
        return;
    }
    const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()];
    if (!mimeType) {
        json(response, 404, { error: "Not found." });
        return;
    }

    fs.stat(filePath).then((info) => {
        if (!info.isFile()) {
            json(response, 404, { error: "Not found." });
            return;
        }
        response.writeHead(200, {
            "Content-Type": mimeType,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": [".html", ".css", ".js"].includes(path.extname(filePath).toLowerCase())
                ? "no-cache"
                : "public, max-age=3600"
        });
        if (request.method === "HEAD") {
            response.end();
            return;
        }
        createReadStream(filePath).pipe(response);
    }).catch((error) => {
        if (error.code === "ENOENT") {
            json(response, 404, { error: "Not found." });
            return;
        }
        console.error("Failed to serve a static file:", error);
        json(response, 500, { error: "Could not load this page." });
    });
}

function addDays(dateString, days) {
    const date = new Date(`${dateString}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function isIsoDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).valueOf());
}

function findByCredentials(body) {
    const reference = typeof body?.reference === "string" ? body.reference.trim().toLowerCase() : "";
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!reference || !email) return null;
    return bookings.find((booking) =>
        booking.id.toLowerCase() === reference && String(booking.email || "").toLowerCase() === email
    ) || null;
}

function cancellationEligibility(booking) {
    if (booking.status === "cancelled") {
        return { allowed: false, reason: "This booking has already been cancelled." };
    }
    if (booking.status === "rejected") {
        return { allowed: false, reason: "This booking is no longer active." };
    }
    if (booking.status === "pending") {
        return { allowed: true };
    }
    const checkIn = new Date(`${booking.checkIn}T00:00:00.000Z`).valueOf();
    if (Date.now() > checkIn - CANCELLATION_NOTICE_MS) {
        return { allowed: false, reason: "Confirmed bookings can only be cancelled up to 48 hours before check-in. Please contact the hotel." };
    }
    return { allowed: true };
}

function publicPaymentView(booking) {
    const payment = booking.payment || {};
    return {
        state: payment.state || "not_required",
        amount: payment.amount || booking.depositDue || 0,
        receipt: payment.receipt || null,
        message: payment.message || null,
        currency: payment.currency || "KSh"
    };
}

function publicBookingView(booking) {
    if (!booking) return null;
    return {
        id: booking.id,
        name: booking.name,
        roomType: booking.roomType,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        guests: booking.guests,
        nights: booking.nights,
        nightlyRate: booking.nightlyRate,
        totalPrice: booking.totalPrice,
        depositDue: booking.depositDue,
        status: booking.status,
        createdAt: booking.createdAt,
        cancelledAt: booking.cancelledAt || null,
        payment: publicPaymentView(booking)
    };
}

async function settlePayment(bookingId, patch) {
    const updatedBookings = await updateBookings((currentBookings) => {
        const index = currentBookings.findIndex((booking) => booking.id === bookingId);
        if (index < 0) return null;
        const current = currentBookings[index];
        const nextBookings = [...currentBookings];
        let updated = {
            ...current,
            payment: { ...current.payment, ...patch },
            updatedAt: new Date().toISOString()
        };
        if (patch.state === "paid" && current.status === "pending") {
            const availability = checkAvailability(current.roomType, current.checkIn, current.checkOut, currentBookings, current.id);
            if (availability.available) {
                updated = { ...updated, status: "confirmed", confirmedAt: new Date().toISOString() };
            } else {
                updated = { ...updated, payment: { ...updated.payment, conflict: true } };
            }
        }
        nextBookings[index] = updated;
        return nextBookings;
    });
    const updated = updatedBookings ? updatedBookings.find((booking) => booking.id === bookingId) : null;
    if (updated && patch.state === "paid") {
        notifyAsync("payment.received", updated);
        if (updated.status === "confirmed") notifyAsync("booking.confirmed", updated);
        else if (updated.payment?.conflict) notifyAsync("payment.conflict", updated);
    }
    return updated;
}

function buildOccupancy(from, to) {
    const dates = [];
    const cursor = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(`${to}T00:00:00.000Z`);
    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return ROOM_TYPES.map((room) => ({
        roomType: room.name,
        totalRooms: room.totalRooms,
        days: dates.map((date) => {
            const held = bookings.filter((booking) =>
                booking.roomType === room.name &&
                (booking.status === "pending" || booking.status === "confirmed") &&
                booking.checkIn <= date &&
                date < booking.checkOut
            );
            return {
                date,
                occupied: held.length,
                confirmed: held.filter((booking) => booking.status === "confirmed").length,
                pending: held.filter((booking) => booking.status === "pending").length,
                guests: held.map((booking) => ({ name: booking.name, status: booking.status }))
            };
        })
    }));
}

async function handleApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/rooms") {
        json(response, 200, {
            rooms: ROOM_TYPES.map(({ id, name, nightlyRate, totalRooms, maxGuests }) => ({
                id, name, nightlyRate, totalRooms, maxGuests
            }))
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/quote") {
        const roomType = url.searchParams.get("roomType") || "";
        const checkIn = url.searchParams.get("checkIn") || "";
        const checkOut = url.searchParams.get("checkOut") || "";
        const room = getRoomType(roomType);
        const result = validateStay(room, checkIn, checkOut);
        if (!result.valid) {
            json(response, 400, { error: result.error });
            return;
        }
        json(response, 200, { quote: buildQuote(room, checkIn, checkOut) });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/bookings") {
        const body = await readJson(request);
        const result = validateBooking(body);
        if (!result.valid) {
            json(response, 400, { error: result.error });
            return;
        }

        const { roomType, checkIn, checkOut } = result.booking;
        const room = getRoomType(roomType);
        const quote = buildQuote(room, checkIn, checkOut);
        const paymentsEnabled = isPaymentConfigured();
        let booking;
        await updateBookings((currentBookings) => {
            const availability = checkAvailability(roomType, checkIn, checkOut, currentBookings);
            if (!availability.available) {
                const error = new Error(`All ${roomType}s are booked for those dates. Choose different dates or another room type.`);
                error.statusCode = 409;
                throw error;
            }
            booking = {
                id: randomUUID(),
                ...result.booking,
                nights: quote.nights,
                nightlyRate: quote.baseNightlyRate,
                baseTotal: quote.baseTotal,
                subtotal: quote.subtotal,
                discount: quote.discount,
                totalPrice: quote.totalPrice,
                depositDue: quote.depositDue,
                priceBreakdown: {
                    nightlyRates: quote.nightlyRates,
                    discountLabel: quote.discountLabel,
                    depositPercent: quote.depositPercent
                },
                payment: {
                    state: paymentsEnabled ? "required" : "not_required",
                    amount: quote.depositDue,
                    currency: quote.currency
                },
                status: "pending",
                createdAt: new Date().toISOString()
            };
            return [booking, ...currentBookings];
        });
        notifyAsync("booking.created", booking);
        json(response, 201, {
            message: "Booking request received.",
            paymentRequired: paymentsEnabled,
            booking: {
                id: booking.id,
                status: booking.status,
                nights: booking.nights,
                totalPrice: booking.totalPrice,
                depositDue: booking.depositDue,
                currency: quote.currency
            }
        });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
        const ip = request.socket.remoteAddress || "unknown";
        if (loginIsLimited(ip)) {
            json(response, 429, { error: "Too many sign-in attempts. Try again later." }, { "Retry-After": String(loginRetryAfter(ip)) });
            return;
        }

        const body = await readJson(request);
        const username = body && typeof body.username === "string" ? body.username : "";
        const password = body && typeof body.password === "string" ? body.password : "";
        const submitted = await scrypt(password, passwordSalt, 64);
        const usernameMatches = timingSafeEqual(
            createHash("sha256").update(username).digest(),
            createHash("sha256").update(ADMIN_USERNAME).digest()
        );
        const passwordMatches = timingSafeEqual(submitted, passwordVerifier);
        if (!usernameMatches || !passwordMatches) {
            recordFailedLogin(ip);
            json(response, 401, { error: "Incorrect username or password." });
            return;
        }

        loginAttempts.delete(ip);
        const token = randomBytes(32).toString("base64url");
        sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
        sendSessionCookie(response, token, request);
        json(response, 200, { message: "Signed in." });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, { authenticated: Boolean(getSession(request)) });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
        const session = getSession(request);
        if (session) sessions.delete(session.token);
        response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${request.socket.encrypted ? "; Secure" : ""}`);
        json(response, 200, { message: "Signed out." });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/bookings") {
        if (!requireSession(request, response)) return;
        const status = url.searchParams.get("status");
        const search = (url.searchParams.get("search") || "").trim().toLowerCase();
        let filtered = bookings;
        if (status && ALLOWED_STATUSES.has(status)) {
            filtered = filtered.filter((booking) => booking.status === status);
        }
        if (search) {
            filtered = filtered.filter((booking) =>
                [booking.name, booking.email, booking.phone, booking.id]
                    .some((value) => String(value || "").toLowerCase().includes(search))
            );
        }
        const counts = { total: bookings.length, pending: 0, confirmed: 0, rejected: 0, cancelled: 0 };
        for (const booking of bookings) {
            if (booking.status in counts) counts[booking.status] += 1;
        }
        json(response, 200, { bookings: filtered, total: bookings.length, counts });
        return;
    }

    if (request.method === "GET" && url.pathname === "/api/occupancy") {
        if (!requireSession(request, response)) return;
        const from = url.searchParams.get("from") || new Date().toISOString().slice(0, 10);
        const to = url.searchParams.get("to") || addDays(from, 14);
        if (!isIsoDate(from) || !isIsoDate(to) || to < from) {
            json(response, 400, { error: "Choose a valid occupancy date range." });
            return;
        }
        json(response, 200, { from, to, roomTypes: buildOccupancy(from, to) });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/bookings/lookup") {
        const ip = request.socket.remoteAddress || "unknown";
        if (loginIsLimited(ip)) {
            json(response, 429, { error: "Too many attempts. Try again later." }, { "Retry-After": String(loginRetryAfter(ip)) });
            return;
        }
        const body = await readJson(request);
        const booking = findByCredentials(body);
        if (!booking) {
            recordFailedLogin(ip);
            json(response, 404, { error: "We could not find a booking with that reference and email." });
            return;
        }
        loginAttempts.delete(ip);
        json(response, 200, { booking: publicBookingView(booking) });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/bookings/cancel") {
        const ip = request.socket.remoteAddress || "unknown";
        if (loginIsLimited(ip)) {
            json(response, 429, { error: "Too many attempts. Try again later." }, { "Retry-After": String(loginRetryAfter(ip)) });
            return;
        }
        const body = await readJson(request);
        const existing = findByCredentials(body);
        if (!existing) {
            recordFailedLogin(ip);
            json(response, 404, { error: "We could not find a booking with that reference and email." });
            return;
        }
        const eligibility = cancellationEligibility(existing);
        if (!eligibility.allowed) {
            json(response, 409, { error: eligibility.reason });
            return;
        }
        loginAttempts.delete(ip);
        const updatedBookings = await updateBookings((currentBookings) => {
            const index = currentBookings.findIndex((booking) => booking.id === existing.id);
            if (index < 0) return null;
            const nextBookings = [...currentBookings];
            nextBookings[index] = {
                ...nextBookings[index],
                status: "cancelled",
                cancelledAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            return nextBookings;
        });
        const updated = updatedBookings ? updatedBookings.find((booking) => booking.id === existing.id) : null;
        if (updated) notifyAsync("booking.cancelled", updated);
        json(response, 200, { message: "Your booking was cancelled.", booking: publicBookingView(updated) });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/payments/stk") {
        if (!isPaymentConfigured()) {
            json(response, 400, { error: "M-Pesa payments are not available right now." });
            return;
        }
        const ip = request.socket.remoteAddress || "unknown";
        if (loginIsLimited(ip)) {
            json(response, 429, { error: "Too many attempts. Try again later." }, { "Retry-After": String(loginRetryAfter(ip)) });
            return;
        }
        const body = await readJson(request);
        const existing = findByCredentials(body);
        if (!existing) {
            recordFailedLogin(ip);
            json(response, 404, { error: "We could not find a booking with that reference and email." });
            return;
        }
        if (existing.status === "cancelled" || existing.status === "rejected") {
            json(response, 409, { error: "This booking is no longer active." });
            return;
        }
        if (existing.payment?.state === "paid") {
            json(response, 409, { error: "The deposit for this booking is already paid." });
            return;
        }
        const phone = normalizeMsisdn(body.phone);
        if (!phone) {
            json(response, 400, { error: "Enter a valid M-Pesa phone number (e.g. 0712 345 678)." });
            return;
        }
        let push;
        try {
            push = await stkPush({
                phone,
                amount: existing.depositDue || existing.payment?.amount || 0,
                accountReference: existing.id.slice(0, 12),
                description: "Dream Hotel deposit"
            });
        } catch (error) {
            json(response, 502, { error: error.message });
            return;
        }
        await updateBookings((currentBookings) => {
            const index = currentBookings.findIndex((booking) => booking.id === existing.id);
            if (index < 0) return null;
            const nextBookings = [...currentBookings];
            nextBookings[index] = {
                ...nextBookings[index],
                payment: {
                    ...nextBookings[index].payment,
                    state: "prompted",
                    promptAmount: existing.depositDue || existing.payment?.amount || 0,
                    checkoutRequestId: push.checkoutRequestId,
                    merchantRequestId: push.merchantRequestId,
                    phone,
                    promptedAt: new Date().toISOString()
                },
                updatedAt: new Date().toISOString()
            };
            return nextBookings;
        });
        json(response, 202, {
            message: push.customerMessage || "Check your phone to complete the M-Pesa deposit.",
            checkoutRequestId: push.checkoutRequestId
        });
        return;
    }

    const paymentStatusMatch = url.pathname.match(/^\/api\/payments\/([0-9a-f-]{36})\/status$/i);
    if (request.method === "GET" && paymentStatusMatch) {
        const existing = bookings.find((booking) => booking.id === paymentStatusMatch[1]);
        if (!existing) {
            json(response, 404, { error: "Booking request not found." });
            return;
        }
        if (existing.payment?.state === "paid") {
            json(response, 200, { payment: publicPaymentView(existing), booking: publicBookingView(existing) });
            return;
        }
        if (!existing.payment?.checkoutRequestId || existing.payment.state !== "prompted") {
            json(response, 200, { payment: publicPaymentView(existing), booking: publicBookingView(existing) });
            return;
        }
        let result;
        try {
            result = await stkQuery(existing.payment.checkoutRequestId);
        } catch (error) {
            json(response, 200, { payment: publicPaymentView(existing), booking: publicBookingView(existing), note: error.message });
            return;
        }
        if (result.paid) {
            const updated = await settlePayment(existing.id, { state: "paid", receipt: result.receipt, paidAt: new Date().toISOString() });
            json(response, 200, { payment: publicPaymentView(updated), booking: publicBookingView(updated) });
            return;
        }
        if (result.failed) {
            const updated = await settlePayment(existing.id, { state: "failed", message: result.message, failedAt: new Date().toISOString() });
            json(response, 200, { payment: publicPaymentView(updated), booking: publicBookingView(updated) });
            return;
        }
        json(response, 200, { payment: publicPaymentView(existing), booking: publicBookingView(existing), note: result.message });
        return;
    }

    if (request.method === "POST" && url.pathname === "/api/mpesa/callback") {
        const body = await readJson(request);
        const callback = parseCallback(body);
        if (!callback || !callback.checkoutRequestId) {
            json(response, 200, { ResultCode: 0, ResultDesc: "Ignored." });
            return;
        }
        const match = bookings.find((booking) => booking.payment?.checkoutRequestId === callback.checkoutRequestId);
        if (!match) {
            json(response, 200, { ResultCode: 0, ResultDesc: "Ignored." });
            return;
        }
        if (callback.paid) {
            await settlePayment(match.id, { state: "paid", receipt: callback.receipt, paidAt: new Date().toISOString() });
        } else {
            await settlePayment(match.id, { state: "failed", message: callback.message, failedAt: new Date().toISOString() });
        }
        json(response, 200, { ResultCode: 0, ResultDesc: "Accepted." });
        return;
    }

    const bookingMatch = url.pathname.match(/^\/api\/bookings\/([0-9a-f-]{36})$/i);
    if (request.method === "PATCH" && bookingMatch) {
        if (!requireSession(request, response)) return;
        const body = await readJson(request);
        if (!body || !ALLOWED_STATUSES.has(body.status)) {
            json(response, 400, { error: "Choose a valid booking status." });
            return;
        }
        const updatedBookings = await updateBookings((currentBookings) => {
            const index = currentBookings.findIndex((booking) => booking.id === bookingMatch[1]);
            if (index < 0) return null;
            const current = currentBookings[index];
            if (body.status === "confirmed" && current.status !== "confirmed") {
                const availability = checkAvailability(current.roomType, current.checkIn, current.checkOut, currentBookings, current.id);
                if (!availability.available) {
                    const error = new Error(`No ${current.roomType}s are free for those dates. Reject the overlapping request first or ask the guest for new dates.`);
                    error.statusCode = 409;
                    throw error;
                }
            }
            const nextBookings = [...currentBookings];
            nextBookings[index] = { ...nextBookings[index], status: body.status, updatedAt: new Date().toISOString() };
            return nextBookings;
        });
        if (!updatedBookings) {
            json(response, 404, { error: "Booking request not found." });
            return;
        }
        const updated = updatedBookings.find((booking) => booking.id === bookingMatch[1]);
        const eventName = ["confirmed", "rejected", "cancelled", "updated"].includes(body.status) ? body.status : "updated";
        notifyAsync(`booking.${eventName}`, updated);
        json(response, 200, { booking: updated });
        return;
    }

    json(response, 404, { error: "API endpoint not found." });
}

async function handleRequest(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST" && request.method !== "PATCH") {
        json(response, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD, POST, PATCH" });
        return;
    }

    let url;
    try {
        url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    } catch {
        json(response, 400, { error: "Invalid URL." });
        return;
    }

    if (url.pathname.startsWith("/api/")) {
        try {
            await handleApi(request, response, url);
        } catch (error) {
            if (error.statusCode) {
                json(response, error.statusCode, { error: error.message });
                return;
            }
            console.error("API request failed:", error);
            json(response, 500, { error: "The request could not be completed. Please try again." });
        }
        return;
    }

    if (request.method === "POST" || request.method === "PATCH") {
        json(response, 404, { error: "Not found." });
        return;
    }
    sendStaticFile(request, response, url.pathname);
}

async function start() {
    if (ADMIN_PASSWORD.length < 12) {
        throw new Error("Set HOTEL_ADMIN_PASSWORD to a password of at least 12 characters before starting the server.");
    }
    passwordSalt = randomBytes(16);
    passwordVerifier = await scrypt(ADMIN_PASSWORD, passwordSalt, 64);
    await fs.mkdir(DATA_DIR, { recursive: true, ...PRIVATE_DIRECTORY_OPTIONS });
    try {
        const saved = JSON.parse(await fs.readFile(BOOKINGS_FILE, "utf8"));
        if (!Array.isArray(saved)) throw new Error("Expected an array of bookings.");
        bookings = saved;
    } catch (error) {
        if (error.code !== "ENOENT") throw new Error(`Could not load saved bookings: ${error.message}`);
        await fs.writeFile(BOOKINGS_FILE, "[]", PRIVATE_FILE_OPTIONS);
        bookings = [];
    }

    const server = createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
            console.error("Request handling failed:", error);
            if (!response.headersSent) {
                json(response, 500, { error: "An unexpected server error occurred." });
            } else {
                response.destroy(error);
            }
        });
    });
    server.listen(PORT, HOST, () => {
        console.log(`Dream Hotel is running at http://${HOST}:${PORT}`);
        console.log(`Manager login username: ${ADMIN_USERNAME}`);
        console.log(`Manager dashboard: http://${HOST}:${PORT}/admin.html`);
    });
}

start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
