import { describe, expect, it } from "vitest";

import {
  LEGACY_PI_DESKTOP_IDENTITY,
  OMP_RUNTIME_HOME_DIRS,
  PRODUCT_IDENTITY,
  assertIndependentIdentity,
  identityCollisions,
  reservedIdentityNames,
  type ProductIdentity,
} from "./app-identity.js";
import { APP_ID, APP_NAME } from "./protocol.js";

describe("product identity", () => {
  it("shares no machine-level name with the product it was forked from", () => {
    expect(identityCollisions(PRODUCT_IDENTITY, LEGACY_PI_DESKTOP_IDENTITY)).toEqual([]);
    expect(() => assertIndependentIdentity()).not.toThrow();
  });

  it("does not reuse an OMP runtime home directory", () => {
    const reserved = new Set<string>(OMP_RUNTIME_HOME_DIRS);
    for (const name of [
      PRODUCT_IDENTITY.dataDirName,
      PRODUCT_IDENTITY.developmentDataDirName,
      PRODUCT_IDENTITY.userDataName,
      PRODUCT_IDENTITY.developmentUserDataName,
      PRODUCT_IDENTITY.credentialNamespace,
    ]) {
      expect(reserved.has(name), name).toBe(false);
    }
  });

  it("keeps a shipped and a development installation apart", () => {
    expect(PRODUCT_IDENTITY.dataDirName).not.toBe(PRODUCT_IDENTITY.developmentDataDirName);
    expect(PRODUCT_IDENTITY.userDataName).not.toBe(PRODUCT_IDENTITY.developmentUserDataName);
  });

  it("points updates at this product, not at the upstream feed", () => {
    const source = PRODUCT_IDENTITY.updateSource;
    expect(source).not.toBeNull();
    expect(source?.owner).not.toBe(LEGACY_PI_DESKTOP_IDENTITY.updateSource?.owner);
    expect(source?.repo).not.toBe(LEGACY_PI_DESKTOP_IDENTITY.updateSource?.repo);
    expect(source?.releasesUrl).toBe(
      `https://github.com/${source?.owner}/${source?.repo}/releases/latest`,
    );
  });

  it("detects a collision when an identity is copied from the fork", () => {
    const collisions = identityCollisions(LEGACY_PI_DESKTOP_IDENTITY, LEGACY_PI_DESKTOP_IDENTITY);
    expect(collisions).toContain("dataDirName");
    expect(() => assertIndependentIdentity(LEGACY_PI_DESKTOP_IDENTITY)).toThrow(/collides/);
  });

  it("detects a reserved runtime directory and an upstream feed", () => {
    const reserver: ProductIdentity = { ...PRODUCT_IDENTITY, dataDirName: ".omp" };
    expect(() => assertIndependentIdentity(reserver)).toThrow(/OMP runtime directory/);
    const upstreamFeed: ProductIdentity = {
      ...PRODUCT_IDENTITY,
      updateSource: LEGACY_PI_DESKTOP_IDENTITY.updateSource,
    };
    expect(() => assertIndependentIdentity(upstreamFeed)).toThrow(/upstream product/);
  });

  it("lists the names this product must avoid", () => {
    const reserved = reservedIdentityNames();
    expect(reserved).toContain(LEGACY_PI_DESKTOP_IDENTITY.dataDirName);
    expect(reserved).toContain(".omp");
  });

  it("drives the shared protocol constants", () => {
    expect(APP_NAME).toBe(PRODUCT_IDENTITY.name);
    expect(APP_ID).toBe(PRODUCT_IDENTITY.appId);
  });
});
