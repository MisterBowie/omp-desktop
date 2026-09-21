import assert from "node:assert/strict";
import test from "node:test";
import { commitWorkPanelPresentation } from "../src/lib/work-panel-presentation.ts";

test("commits a successful current work panel reservation", async () => {
  let presented = false;

  const committed = await commitWorkPanelPresentation({
    reservation: Promise.resolve({ requested: 420, reserved: 420 }),
    isCurrent: () => true,
    commit: () => {
      presented = true;
    },
  });

  assert.equal(committed, true);
  assert.equal(presented, true);
});

test("keeps the confirmed presentation when reservation fails", async () => {
  let presented = true;

  const committed = await commitWorkPanelPresentation({
    reservation: Promise.reject(new Error("reservation failed")),
    isCurrent: () => true,
    commit: () => {
      presented = false;
    },
  });

  assert.equal(committed, false);
  assert.equal(presented, true);
});

test("ignores a successful reservation superseded by a newer request", async () => {
  let presented = false;

  const committed = await commitWorkPanelPresentation({
    reservation: Promise.resolve({ requested: 420, reserved: 420 }),
    isCurrent: () => false,
    commit: () => {
      presented = true;
    },
  });

  assert.equal(committed, false);
  assert.equal(presented, false);
});
