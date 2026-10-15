#!/usr/bin/env node
import { parseArgs } from "node:util";
import { inspectInstalledProduct } from "./e2e/installed-product.mjs";
try {
  const { values } = parseArgs({ options: { app: { type: "string" } }, allowPositionals: false });
  if (!values.app) throw new Error("--app <actual installed application directory> is required");
  console.log(JSON.stringify(inspectInstalledProduct(values.app), null, 2));
} catch (error) {
  console.error(`INSTALLED-PRODUCT-FAIL: ${error.message}`);
  process.exitCode = 1;
}
