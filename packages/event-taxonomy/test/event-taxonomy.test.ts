import { expect, test } from "bun:test";
import { PACKAGE_NAME, packageInfo } from "../src/index.ts";

test("package is importable", () => {
  expect(PACKAGE_NAME).toBe("@scantron/event-taxonomy");
  expect(packageInfo().implementedBy).toBe("S-A4");
});
