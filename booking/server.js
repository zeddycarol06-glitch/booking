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
import { validateBooking } from "./validation.js";

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
const ALLOWED_STATUSES = new Set(["pending", "confirmed", "rejected"]);
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

async function handleApi(request, response, url) {
    if (request.method === "POST" && url.pathname === "/api/bookings") {
        const body = await readJson(request);
        const result = validateBooking(body);
        if (!result.valid) {
            json(response, 400, { error: result.error });
            return;
        }

        const booking = {
            id: randomUUID(),
            ...result.booking,
            status: "pending",
            createdAt: new Date().toISOString()
        };
        await updateBookings((currentBookings) => [booking, ...currentBookings]);
        json(response, 201, { message: "Booking request received.", booking: { id: booking.id, status: booking.status } });
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
        json(response, 200, { bookings });
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
            const nextBookings = [...currentBookings];
            nextBookings[index] = { ...nextBookings[index], status: body.status, updatedAt: new Date().toISOString() };
            return nextBookings;
        });
        if (!updatedBookings) {
            json(response, 404, { error: "Booking request not found." });
            return;
        }
        const updated = updatedBookings.find((booking) => booking.id === bookingMatch[1]);
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
