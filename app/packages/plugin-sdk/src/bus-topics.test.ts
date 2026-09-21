import { describe, expect, it } from "vitest";
import {
  busTopicAllowed,
  isValidBusTopic,
  isValidBusTopicPattern,
  matchesBusTopic,
} from "./bus-topics.js";

describe("isValidBusTopic", () => {
  it("accepts dotted segments", () => {
    expect(isValidBusTopic("notes.created")).toBe(true);
    expect(isValidBusTopic("a")).toBe(true);
  });

  it("rejects wildcards, empty segments and oversized topics", () => {
    expect(isValidBusTopic("notes.*")).toBe(false);
    expect(isValidBusTopic("notes..created")).toBe(false);
    expect(isValidBusTopic("")).toBe(false);
    expect(isValidBusTopic("a.b.c.d.e.f.g.h.i")).toBe(false);
    expect(isValidBusTopic(`${"a".repeat(129)}`)).toBe(false);
    expect(isValidBusTopic("-leading")).toBe(false);
  });
});

describe("isValidBusTopicPattern", () => {
  it("allows * anywhere and ** only last", () => {
    expect(isValidBusTopicPattern("notes.*")).toBe(true);
    expect(isValidBusTopicPattern("*.created")).toBe(true);
    expect(isValidBusTopicPattern("notes.**")).toBe(true);
    expect(isValidBusTopicPattern("notes.**.x")).toBe(false);
  });
});

describe("matchesBusTopic", () => {
  it("matches exact topics", () => {
    expect(matchesBusTopic("notes.created", "notes.created")).toBe(true);
    expect(matchesBusTopic("notes.created", "notes.updated")).toBe(false);
  });

  it("matches a single segment with *", () => {
    expect(matchesBusTopic("notes.*", "notes.created")).toBe(true);
    expect(matchesBusTopic("notes.*", "notes.created.v2")).toBe(false);
    expect(matchesBusTopic("notes.*", "notes")).toBe(false);
  });

  it("matches trailing segments with **", () => {
    expect(matchesBusTopic("notes.**", "notes.created")).toBe(true);
    expect(matchesBusTopic("notes.**", "notes.created.v2")).toBe(true);
    expect(matchesBusTopic("notes.**", "notes")).toBe(false);
    expect(matchesBusTopic("**", "anything.here")).toBe(true);
  });

  it("rejects invalid input instead of throwing", () => {
    expect(matchesBusTopic("notes.**.x", "notes.a.x")).toBe(false);
    expect(matchesBusTopic("notes.*", "notes.*")).toBe(false);
  });
});

describe("busTopicAllowed", () => {
  it("requires at least one covering declaration", () => {
    expect(busTopicAllowed(undefined, "notes.created")).toBe(false);
    expect(busTopicAllowed([], "notes.created")).toBe(false);
    expect(busTopicAllowed(["other.*", "notes.*"], "notes.created")).toBe(true);
  });
});
