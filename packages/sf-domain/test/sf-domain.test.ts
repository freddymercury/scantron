import { expect, test } from "bun:test";
import { isWithinSF, SF_BBOX, SF_TIMEZONE } from "../src/index.ts";

test("civic center is inside the SF bbox", () => {
  expect(isWithinSF(37.7793, -122.4193)).toBe(true);
});

test("oakland is outside the SF bbox", () => {
  expect(isWithinSF(37.8044, -122.2712)).toBe(false);
});

test("bbox is well formed", () => {
  expect(SF_BBOX.west).toBeLessThan(SF_BBOX.east);
  expect(SF_BBOX.south).toBeLessThan(SF_BBOX.north);
  expect(SF_TIMEZONE).toBe("America/Los_Angeles");
});
