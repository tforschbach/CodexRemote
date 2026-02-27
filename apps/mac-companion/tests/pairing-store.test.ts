import { strict as assert } from "node:assert";
import test from "node:test";

import { PairingStore } from "../src/pairing/pairing-store.js";

test("PairingStore consumes valid session once", () => {
  const store = new PairingStore(60);
  const session = store.createSession();

  const first = store.consumeSession(session.pairingId, session.nonce);
  const second = store.consumeSession(session.pairingId, session.nonce);

  assert.ok(first);
  assert.equal(second, null);
});
