import { expect, test } from "bun:test";
import {
  arrayOf,
  enumOf,
  is,
  number,
  objectOf,
  optional,
  parse,
  recordOf,
  string,
  timestamp,
  unknown,
  ValidationError,
} from "../src/validator.ts";

const Person = objectOf(
  {
    name: string({ minLength: 1 }),
    age: optional(number({ integer: true, min: 0 })),
    tags: optional(arrayOf(string())),
  },
  "Person",
);

test("undeclared keys are dropped, not passed through", () => {
  const value = parse(Person, { name: "ada", ssn: "123-45-6789", __proto__: { evil: true } });
  expect(value).toEqual({ name: "ada" });
  expect(Object.keys(value)).toEqual(["name"]);
});

test("missing required fields are reported by path", () => {
  const result = Person.validate({});
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues).toEqual([{ path: "name", message: "is required" }]);
});

test("optional fields may be absent, but not malformed", () => {
  expect(parse(Person, { name: "ada" })).toEqual({ name: "ada" });
  expect(() => parse(Person, { name: "ada", age: -1 })).toThrow(ValidationError);
  expect(parse(Person, { name: "ada", age: undefined })).toEqual({ name: "ada" });
});

test("nested paths survive into issue messages", () => {
  const schema = objectOf({ people: arrayOf(Person) }, "Team");
  const result = schema.validate({ people: [{ name: "ada" }, { age: 3 }] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues[0]?.path).toBe("people[1].name");
});

test("all issues are collected, not just the first", () => {
  const schema = objectOf({ a: string(), b: number() }, "Two");
  const result = schema.validate({ a: 1, b: "x" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues).toHaveLength(2);
});

test("enums reject values outside the list", () => {
  const colour = enumOf(["red", "blue"] as const);
  expect(is(colour, "red")).toBe(true);
  expect(is(colour, "green")).toBe(false);
});

test("timestamps accept Date or ISO string and always produce Date", () => {
  const at = parse(timestamp(), "2026-09-18T01:02:03.000Z");
  expect(at).toBeInstanceOf(Date);
  expect(at.toISOString()).toBe("2026-09-18T01:02:03.000Z");
  expect(parse(timestamp(), new Date(0)).getTime()).toBe(0);
  expect(is(timestamp(), "not a date")).toBe(false);
  expect(is(timestamp(), new Date("nope"))).toBe(false);
});

test("records keep unknown keys — the one place that is intended", () => {
  const schema = objectOf({ metadata: recordOf(unknown()) }, "WithMetadata");
  expect(parse(schema, { metadata: { anything: 1, else: "two" } })).toEqual({
    metadata: { anything: 1, else: "two" },
  });
});

test("arrays and objects are not interchangeable", () => {
  expect(is(objectOf({}, "Empty"), [])).toBe(false);
  expect(is(arrayOf(string()), { 0: "a" })).toBe(false);
  expect(is(objectOf({}, "Empty"), null)).toBe(false);
});

test("the error message names the subject and the failing paths", () => {
  try {
    parse(Person, { age: "old" }, "Person");
    throw new Error("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain("Person");
    expect((error as ValidationError).message).toContain("name");
    expect((error as ValidationError).issues).toHaveLength(2);
  }
});
