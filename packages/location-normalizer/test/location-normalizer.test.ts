import { expect, test } from "bun:test";
import { PACKAGE_NAME, packageInfo } from "../src/index.ts";

test("package is importable", () => {
  expect(PACKAGE_NAME).toBe("@scantron/location-normalizer");
  expect(packageInfo().implementedBy).toBe("S-C1");
});
