import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCustomerTime } from "../src/domain/calendar";

test("T1. 05:30 → 05:30 AM", () => {
  assert.equal(formatCustomerTime("05:30"), "05:30 AM");
});

test("T2. 06:10 → 06:10 AM", () => {
  assert.equal(formatCustomerTime("06:10"), "06:10 AM");
});

test("T3. 12:00 → 12:00 PM", () => {
  assert.equal(formatCustomerTime("12:00"), "12:00 PM");
});

test("T4. 14:00 → 02:00 PM", () => {
  assert.equal(formatCustomerTime("14:00"), "02:00 PM");
});

test("T5. 16:30 → 04:30 PM", () => {
  assert.equal(formatCustomerTime("16:30"), "04:30 PM");
});

test("T6. 00:00 → 12:00 AM", () => {
  assert.equal(formatCustomerTime("00:00"), "12:00 AM");
});

test("T7. 23:59 → 11:59 PM", () => {
  assert.equal(formatCustomerTime("23:59"), "11:59 PM");
});
