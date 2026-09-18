import { expect, test } from "bun:test";
import { describeService } from "../src/main.ts";

test("service identifies itself", () => {
  expect(describeService()).toEqual({ service: "incident-correlator", implementedBy: "S-D1" });
});
