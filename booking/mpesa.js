import { randomUUID } from "node:crypto";

const CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || "";
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || "";
const SHORTCODE = process.env.MPESA_SHORTCODE || "";
const PASSKEY = process.env.MPESA_PASSKEY || "";
const CALLBACK_URL = process.env.MPESA_CALLBACK_URL || "";
const MPESA_ENV = (process.env.MPESA_ENV || "sandbox").toLowerCase();
export const MPESA_MOCK = /^(1|true|yes)$/i.test(process.env.MPESA_MOCK || "");

const BASE_URL = MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
const REQUEST_TIMEOUT_MS = 15000;
const MOCK_DELAY_MS = 3000;

let cachedToken = null;
let cachedTokenExpiry = 0;
const mockPayments = new Map();

export function isPaymentConfigured() {
    if (MPESA_MOCK) return true;
    return Boolean(CONSUMER_KEY && CONSUMER_SECRET && SHORTCODE && PASSKEY);
}

function timestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds())
    ].join("");
}

function basicAuth() {
    return Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
}

export function normalizeMsisdn(input) {
    if (typeof input !== "string") return null;
    const digits = input.replace(/[^\d]/g, "");
    if (/^254\d{9}$/.test(digits)) return digits;
    if (/^0\d{9}$/.test(digits)) return `254${digits.slice(1)}`;
    if (/^\d{9}$/.test(digits)) return `254${digits}`;
    if (/^\+254\d{9}$/.test(input.trim())) return input.trim().slice(1);
    return null;
}

async function getAccessToken() {
    if (cachedToken && cachedTokenExpiry > Date.now() + 30000) {
        return cachedToken;
    }
    const response = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${basicAuth()}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
        throw new Error(`M-Pesa authentication failed (HTTP ${response.status}).`);
    }
    const data = await response.json();
    cachedToken = data.access_token;
    cachedTokenExpiry = Date.now() + (Number(data.expires_in || 3600) * 1000);
    return cachedToken;
}

function password() {
    return Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp()}`).toString("base64");
}

export async function stkPush({ phone, amount, accountReference, description }) {
    const msisdn = normalizeMsisdn(phone);
    if (!msisdn) {
        throw new Error("Enter a valid M-Pesa phone number (e.g. 0712 345 678).");
    }

    if (MPESA_MOCK) {
        const checkoutRequestId = `MOCK-${randomUUID()}`;
        mockPayments.set(checkoutRequestId, { createdAt: Date.now(), msisdn });
        return {
            checkoutRequestId,
            customerMessage: "Enter your M-Pesa PIN to complete the deposit (mock mode).",
            merchantRequestId: `MOCK-MERCHANT-${randomUUID()}`
        };
    }

    const token = await getAccessToken();
    const response = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            BusinessShortCode: SHORTCODE,
            Password: password(),
            Timestamp: timestamp(),
            TransactionType: "CustomerPayBillOnline",
            Amount: Math.max(1, Math.round(amount)),
            PartyA: msisdn,
            PartyB: SHORTCODE,
            PhoneNumber: msisdn,
            CallBackURL: CALLBACK_URL,
            AccountReference: accountReference,
            TransactionDesc: description || "Dream Hotel deposit"
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const data = await response.json();
    if (!response.ok || data.ResponseCode !== "0") {
        throw new Error(data.errorMessage || data.ResponseDescription || "M-Pesa could not start the payment.");
    }
    return {
        checkoutRequestId: data.CheckoutRequestID,
        customerMessage: data.CustomerMessage,
        merchantRequestId: data.MerchantRequestID
    };
}

export async function stkQuery(checkoutRequestId) {
    if (MPESA_MOCK) {
        const record = mockPayments.get(checkoutRequestId);
        if (!record) return { paid: false, failed: true, message: "Unknown payment." };
        if (Date.now() - record.createdAt >= MOCK_DELAY_MS) {
            return {
                paid: true,
                failed: false,
                receipt: `MOCK${record.createdAt.toString(36).toUpperCase()}`,
                message: "The deposit was received (mock mode)."
            };
        }
        return { paid: false, failed: false, message: "Waiting for the guest to enter their PIN." };
    }

    const token = await getAccessToken();
    const response = await fetch(`${BASE_URL}/mpesa/stkpushquery/v1/query`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            BusinessShortCode: SHORTCODE,
            Password: password(),
            Timestamp: timestamp(),
            CheckoutRequestID: checkoutRequestId
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const data = await response.json();
    if (data.ResultCode === "0") {
        return { paid: true, failed: false, receipt: data.ResultParameters ? findReceipt(data.ResultParameters) : null };
    }
    if (data.ResultCode === "1032" || data.ResultCode === "1037" || data.ResultCode === "2001") {
        return { paid: false, failed: true, message: "The guest did not complete the payment." };
    }
    return { paid: false, failed: false, message: data.ResultDesc || "Payment is still being processed." };
}

function findReceipt(resultParameters) {
    const items = Array.isArray(resultParameters?.ResultParameter)
        ? resultParameters.ResultParameter
        : Array.isArray(resultParameters?.Item)
            ? resultParameters.Item
            : [];
    const receipt = items.find((item) => item.Key === "MpesaReceiptNumber" || item.Name === "MpesaReceiptNumber");
    return receipt ? receipt.Value : null;
}

export function parseCallback(body) {
    const callback = body?.Body?.stkCallback;
    if (!callback) return null;
    const receipt = callback.CallbackMetadata
        ? findReceipt(callback.CallbackMetadata)
        : null;
    return {
        checkoutRequestId: callback.CheckoutRequestID,
        resultCode: String(callback.ResultCode),
        paid: String(callback.ResultCode) === "0",
        receipt,
        message: callback.ResultDesc
    };
}
