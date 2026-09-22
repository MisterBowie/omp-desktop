/**
 * Product identity: every name this application owns on a user's machine.
 *
 * The product is a fork of PI-Desktop, and it must be able to run beside it —
 * and beside the OMP CLI it embeds — without reading, migrating or overwriting
 * anything the other two own. That only holds if the names are defined in one
 * place and checked against the names they must not collide with, instead of
 * being spelled out at each use site.
 *
 * Scope: identity is not branding. Icon, installer artwork, store listing and
 * the marketing name of the shipped product are release work (M6); what lives
 * here is what a *running* installation uses to decide where its data, secrets,
 * window profile, URL scheme and updates come from.
 */

import { APP_ID, APP_NAME } from "./protocol.js";

export type ProductUpdateSource = {
  provider: "github";
  owner: string;
  repo: string;
  /** Public release page; the updater's "what's new" link. */
  releasesUrl: string;
};

export type ProductIdentity = {
  /** Human name: `app.setName`, window and tray titles. */
  name: string;
  /** Reverse-DNS application id: AUMID on Windows, bundle id when packaged. */
  appId: string;
  /** Custom URL scheme this product registers for deep links. */
  protocolScheme: string;
  /** Directory below the user's home that holds host-core data. */
  dataDirName: string;
  /** Data directory of a development profile (never the shipped one). */
  developmentDataDirName: string;
  /** `userData` directory name of a shipped installation. */
  userDataName: string;
  /** `userData` directory name of a development installation. */
  developmentUserDataName: string;
  /**
   * Namespace for OS keychain / secret-store entries. host-core keeps its
   * secrets as files under the data directory, so this names the *store*, not
   * an individual secret: two installations must never share one.
   */
  credentialNamespace: string;
  /**
   * Where this product's updates come from. `null` means the product has no
   * release channel yet, which disables update checking rather than falling
   * back to the upstream fork's feed.
   */
  updateSource: ProductUpdateSource | null;
};

/**
 * The identity of this product. Change it here, not at the call sites:
 * `APP_NAME`/`APP_ID` and the data-directory resolver derive from it.
 */
export const PRODUCT_IDENTITY: ProductIdentity = {
  name: APP_NAME,
  appId: APP_ID,
  protocolScheme: "omp-desktop",
  dataDirName: ".omp-desktop",
  developmentDataDirName: ".omp-desktop-dev",
  userDataName: "OMP Desktop",
  developmentUserDataName: "OMP Desktop Dev",
  credentialNamespace: "omp-desktop",
  updateSource: {
    provider: "github",
    owner: "MisterBowie",
    repo: "omp-desktop",
    releasesUrl: "https://github.com/MisterBowie/omp-desktop/releases/latest",
  },
};

/**
 * The installation this product was forked from. A user may run both, so no
 * field of `PRODUCT_IDENTITY` may equal the corresponding field here — a
 * shared `userData` directory would put two single-instance locks and two
 * renderer stores in one place, and a shared data directory would put two
 * host-core writers over one SQLite file.
 */
export const LEGACY_PI_DESKTOP_IDENTITY: ProductIdentity = {
  name: "PI-Desktop",
  appId: "net.aiuo.pi-desktop",
  protocolScheme: "pi-desktop",
  dataDirName: ".pi-desktop",
  developmentDataDirName: ".pi-desktop-dev",
  userDataName: "PI-Desktop",
  developmentUserDataName: "PI-Desktop Dev",
  credentialNamespace: "pi-desktop",
  updateSource: {
    provider: "github",
    owner: "vastsa",
    repo: "PI-Desktop",
    releasesUrl: "https://github.com/vastsa/PI-Desktop/releases/latest",
  },
};

/**
 * Home-relative directories the OMP CLI already owns. The desktop adapter
 * redirects a child runtime's `HOME` into its own run directory rather than
 * reusing these, so a desktop installation must not name its own data
 * directory after one of them.
 */
export const OMP_RUNTIME_HOME_DIRS = [".omp", ".agent", ".agents"] as const;

/** Every machine-level name; `updateSource` is not a name and is checked separately. */
type IdentityNameField = Exclude<keyof ProductIdentity, "updateSource">;

const IDENTITY_FIELDS: readonly IdentityNameField[] = [
  "name",
  "appId",
  "protocolScheme",
  "dataDirName",
  "developmentDataDirName",
  "userDataName",
  "developmentUserDataName",
  "credentialNamespace",
];

/**
 * Field names where `candidate` and `other` would share one machine-level
 * resource. Empty means the two installations are independent for every name
 * that decides where data, secrets, profiles and links go.
 *
 * `updateSource` is compared separately by `assertIndependentIdentity`: sharing
 * a feed is not a data-safety problem, pointing at the *upstream* product's
 * feed is a correctness problem.
 */
export function identityCollisions(
  candidate: ProductIdentity,
  other: ProductIdentity,
): string[] {
  return IDENTITY_FIELDS.filter((field) => candidate[field] === other[field]);
}

/**
 * Names that are reserved for the systems around this product: the upstream
 * fork, and the OMP runtime's own home directories.
 */
export function reservedIdentityNames(): string[] {
  return [
    ...IDENTITY_FIELDS.map((field) => LEGACY_PI_DESKTOP_IDENTITY[field]),
    ...OMP_RUNTIME_HOME_DIRS,
  ];
}

/** Data-directory-style fields checked against the reserved OMP directories. */
const DIRECTORY_FIELDS: readonly IdentityNameField[] = [
  "dataDirName",
  "developmentDataDirName",
  "userDataName",
  "developmentUserDataName",
  "credentialNamespace",
];

/**
 * Throws when an installation would share an identity name with the upstream
 * fork or with the OMP runtime's own directories. Called by tests over
 * `PRODUCT_IDENTITY`; a false result is a data-safety bug, not a style issue.
 */
export function assertIndependentIdentity(
  candidate: ProductIdentity = PRODUCT_IDENTITY,
): void {
  const collisions = identityCollisions(candidate, LEGACY_PI_DESKTOP_IDENTITY);
  if (collisions.length > 0) {
    throw new Error(
      `product identity collides with ${LEGACY_PI_DESKTOP_IDENTITY.name} on: ${collisions.join(", ")}`,
    );
  }
  const reserved = new Set<string>(OMP_RUNTIME_HOME_DIRS);
  const taken = DIRECTORY_FIELDS.filter((field) => reserved.has(candidate[field]));
  if (taken.length > 0) {
    throw new Error(
      `product identity reuses an OMP runtime directory on: ${taken
        .map((field) => `${field}=${candidate[field]}`)
        .join(", ")}`,
    );
  }
  if (
    candidate.updateSource &&
    candidate.updateSource.owner === LEGACY_PI_DESKTOP_IDENTITY.updateSource?.owner &&
    candidate.updateSource.repo === LEGACY_PI_DESKTOP_IDENTITY.updateSource?.repo
  ) {
    throw new Error(
      "product update source points at the upstream product's release feed",
    );
  }
}
