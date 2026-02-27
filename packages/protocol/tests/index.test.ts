import { strict as assert } from "node:assert";
import test from "node:test";

import { assertNonEmptyString } from "../src/index.js";

test("assertNonEmptyString returns the same string for valid input", () => {
  const value = assertNonEmptyString("hello", "field");
  assert.equal(value, "hello");
});

test("assertNonEmptyString throws on empty input", () => {
  assert.throws(() => assertNonEmptyString("", "field"));
});
