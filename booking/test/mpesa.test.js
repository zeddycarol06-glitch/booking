import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMsisdn, parseCallback } from "../mpesa.js";

test("normalizes the common Kenyan phone formats", () => {
    assert.equal(normalizeMsisdn("0712345678"), "254712345678");
    assert.equal(normalizeMsisdn("0112345678"), "254112345678");
    assert.equal(normalizeMsisdn("254712345678"), "254712345678");
    assert.equal(normalizeMsisdn("+254712345678"), "254712345678");
    assert.equal(normalizeMsisdn("712345678"), "254712345678");
    assert.equal(normalizeMsisdn("0712 345 678"), "254712345678");
});

test("rejects invalid phone numbers", () => {
    assert.equal(normalizeMsisdn("123"), null);
    assert.equal(normalizeMsisdn("07123456789012"), null);
    assert.equal(normalizeMsisdn("not-a-number"), null);
    assert.equal(normalizeMsisdn(null), null);
});

test("parses a successful STK callback", () => {
    const result = parseCallback({
        Body: {
            stkCallback: {
                CheckoutRequestID: "ws_CO_123",
                ResultCode: 0,
                ResultDesc: "The service request is processed successfully.",
                CallbackMetadata: {
                    Item: [
                        { Name: "Amount", Value: 1500 },
                        { Name: "MpesaReceiptNumber", Value: "QK12ABC34" }
                    ]
                }
            }
        }
    });
    assert.equal(result.paid, true);
    assert.equal(result.checkoutRequestId, "ws_CO_123");
    assert.equal(result.receipt, "QK12ABC34");
});

test("parses a failed STK callback", () => {
    const result = parseCallback({
        Body: {
            stkCallback: {
                CheckoutRequestID: "ws_CO_456",
                ResultCode: 1032,
                ResultDesc: "Request cancelled by user."
            }
        }
    });
    assert.equal(result.paid, false);
    assert.equal(result.receipt, null);
});

test("returns null for malformed callback bodies", () => {
    assert.equal(parseCallback({}), null);
    assert.equal(parseCallback(null), null);
});
