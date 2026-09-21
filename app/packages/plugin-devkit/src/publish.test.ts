import { describe, expect, it } from "vitest";
import { canonicalRepositoryUrl } from "./publish.js";

describe("canonicalRepositoryUrl", () => {
  it("rewrites the ssh remotes publishers actually have locally", () => {
    expect(canonicalRepositoryUrl("git@github.com:acme/pi-plugin-todo.git")).toBe(
      "https://github.com/acme/pi-plugin-todo",
    );
    expect(canonicalRepositoryUrl("ssh://git@cnb.cool/acme/todo.git")).toBe(
      "https://cnb.cool/acme/todo",
    );
  });

  it("keeps an https remote and strips what a canonical URL must not carry", () => {
    expect(canonicalRepositoryUrl("https://github.com/acme/pi-plugin-todo.git")).toBe(
      "https://github.com/acme/pi-plugin-todo",
    );
    expect(
      canonicalRepositoryUrl("https://github.com/acme/pi-plugin-todo?tab=readme#top"),
    ).toBe("https://github.com/acme/pi-plugin-todo");
  });

  it("refuses a remote that cannot become public submission data", () => {
    // A token in the remote would end up in the payload and, from there, in
    // whatever the publisher pastes into an issue or a CI log.
    expect(() =>
      canonicalRepositoryUrl("https://user:token@github.com/acme/todo.git"),
    ).toThrow(/credentials/);
    expect(() => canonicalRepositoryUrl("http://github.com/acme/todo")).toThrow(/https/);
    expect(() => canonicalRepositoryUrl("/srv/git/todo")).toThrow(/unsupported git remote/);
  });
});
