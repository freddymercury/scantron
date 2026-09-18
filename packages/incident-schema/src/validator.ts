/**
 * A tiny validation kit. ADR-002 chose to own this rather than take Zod, for one reason
 * that matters more than size: **objects are allowlists**. A key that is not declared is
 * dropped, never passed through — so an internal field cannot reach a public payload by
 * being forgotten. That is a structural guarantee, not a test we have to remember to write.
 */

export interface Issue {
  /** Dotted path to the offending value, e.g. `location.latitude` or `units[2]`. */
  path: string;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface Validator<T> {
  readonly kind: string;
  /** Present on `optional(...)`; object validators use it to allow a missing key. */
  readonly optional?: boolean;
  validate(input: unknown, path?: string): Result<T>;
}

export type Infer<V> = V extends Validator<infer T> ? T : never;

export class ValidationError extends Error {
  constructor(
    readonly issues: Issue[],
    subject: string,
  ) {
    super(`${subject}: ${issues.map((i) => `${i.path || "<root>"} ${i.message}`).join("; ")}`);
    this.name = "ValidationError";
  }
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const bad = (path: string, message: string): Result<never> => ({
  ok: false,
  issues: [{ path, message }],
});

function define<T>(
  kind: string,
  validate: (input: unknown, path: string) => Result<T>,
): Validator<T> {
  return { kind, validate: (input, path = "") => validate(input, path) };
}

/** Validate and throw on failure. Use at trust boundaries, not in hot loops. */
export function parse<T>(validator: Validator<T>, input: unknown, subject = validator.kind): T {
  const result = validator.validate(input, "");
  if (result.ok) return result.value;
  throw new ValidationError(result.issues, subject);
}

export function is<T>(validator: Validator<T>, input: unknown): input is T {
  return validator.validate(input, "").ok;
}

// --- scalars ---------------------------------------------------------------

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
}

export function string(options: StringOptions = {}): Validator<string> {
  return define("string", (input, path) => {
    if (typeof input !== "string") return bad(path, `must be a string, got ${typeName(input)}`);
    if (options.minLength !== undefined && input.length < options.minLength) {
      return bad(path, `must be at least ${options.minLength} characters`);
    }
    if (options.maxLength !== undefined && input.length > options.maxLength) {
      return bad(path, `must be at most ${options.maxLength} characters`);
    }
    if (options.pattern && !options.pattern.test(input)) {
      return bad(path, `must match ${options.pattern}`);
    }
    return ok(input);
  });
}

export interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function number(options: NumberOptions = {}): Validator<number> {
  return define("number", (input, path) => {
    if (typeof input !== "number" || !Number.isFinite(input)) {
      return bad(path, `must be a finite number, got ${typeName(input)}`);
    }
    if (options.integer && !Number.isInteger(input)) return bad(path, "must be an integer");
    if (options.min !== undefined && input < options.min) {
      return bad(path, `must be >= ${options.min}`);
    }
    if (options.max !== undefined && input > options.max) {
      return bad(path, `must be <= ${options.max}`);
    }
    return ok(input);
  });
}

export function boolean(): Validator<boolean> {
  return define("boolean", (input, path) =>
    typeof input === "boolean" ? ok(input) : bad(path, `must be a boolean, got ${typeName(input)}`),
  );
}

export function literal<const T extends string | number | boolean>(value: T): Validator<T> {
  return define(`literal(${String(value)})`, (input, path) =>
    input === value ? ok(value) : bad(path, `must be ${JSON.stringify(value)}`),
  );
}

export function enumOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  const allowed = new Set<string>(values);
  return define(`enum(${values.join("|")})`, (input, path) =>
    typeof input === "string" && allowed.has(input)
      ? ok(input as T[number])
      : bad(path, `must be one of ${values.join(", ")}`),
  );
}

/**
 * ISO-8601 UTC instants, accepted as `Date` or string and always produced as `Date`.
 * ADR-003 stores them as sortable UTC TEXT; the domain works in `Date`.
 */
export function timestamp(): Validator<Date> {
  return define("timestamp", (input, path) => {
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? bad(path, "must be a valid Date") : ok(input);
    }
    if (typeof input === "string") {
      const parsed = new Date(input);
      if (Number.isNaN(parsed.getTime())) return bad(path, `must be an ISO-8601 timestamp`);
      return ok(parsed);
    }
    return bad(path, `must be a Date or ISO-8601 string, got ${typeName(input)}`);
  });
}

/** Latitude/longitude, rejected rather than clamped when out of range. */
export const latitude = (): Validator<number> => number({ min: -90, max: 90 });
export const longitude = (): Validator<number> => number({ min: -180, max: 180 });
/** Every confidence in this system is 0..1 inclusive (PRD §22). */
export const confidence = (): Validator<number> => number({ min: 0, max: 1 });

// --- composites ------------------------------------------------------------

export function optional<T>(validator: Validator<T>): Validator<T | undefined> {
  return {
    kind: `optional(${validator.kind})`,
    optional: true,
    validate: (input, path = "") =>
      input === undefined || input === null ? ok(undefined) : validator.validate(input, path),
  };
}

export function arrayOf<T>(item: Validator<T>): Validator<T[]> {
  return define(`array(${item.kind})`, (input, path) => {
    if (!Array.isArray(input)) return bad(path, `must be an array, got ${typeName(input)}`);
    const issues: Issue[] = [];
    const values: T[] = [];
    input.forEach((element, index) => {
      const result = item.validate(element, `${path}[${index}]`);
      if (result.ok) values.push(result.value);
      else issues.push(...result.issues);
    });
    return issues.length > 0 ? { ok: false, issues } : ok(values);
  });
}

/** An open map of string keys — the one place unknown keys survive, by design. */
export function recordOf<T>(value: Validator<T>): Validator<Record<string, T>> {
  return define(`record(${value.kind})`, (input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return bad(path, `must be an object, got ${typeName(input)}`);
    }
    const issues: Issue[] = [];
    const out: Record<string, T> = {};
    for (const [key, element] of Object.entries(input)) {
      const result = value.validate(element, path ? `${path}.${key}` : key);
      if (result.ok) out[key] = result.value;
      else issues.push(...result.issues);
    }
    return issues.length > 0 ? { ok: false, issues } : ok(out);
  });
}

export const unknown = (): Validator<unknown> => define("unknown", (input) => ok(input));

type Shape = Record<string, Validator<unknown>>;

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? K : never;
}[keyof S];

type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

export type ObjectType<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>;
} & {
  // `Exclude<..., undefined>`: an optional key is omitted, never present-and-undefined,
  // which is what `exactOptionalPropertyTypes` asks for and what `objectOf` produces.
  [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
};

export interface ObjectValidator<S extends Shape> extends Validator<ObjectType<S>> {
  readonly shape: S;
  /** Declared keys, in declaration order — the allowlist itself. */
  readonly keys: readonly (keyof S & string)[];
}

/**
 * Allowlist-by-default object validation: declared keys are validated and kept, every
 * other key is silently dropped.
 */
export function objectOf<S extends Shape>(shape: S, name = "object"): ObjectValidator<S> {
  const keys = Object.keys(shape) as (keyof S & string)[];
  return {
    kind: name,
    shape,
    keys,
    validate(input, path = "") {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        return bad(path, `must be an object, got ${typeName(input)}`);
      }
      const source = input as Record<string, unknown>;
      const issues: Issue[] = [];
      const out: Record<string, unknown> = {};

      for (const key of keys) {
        const validator = shape[key] as Validator<unknown>;
        const childPath = path ? `${path}.${key}` : key;
        const value = source[key];

        if (value === undefined || value === null) {
          if (validator.optional) continue; // omit rather than set undefined
          issues.push({ path: childPath, message: "is required" });
          continue;
        }
        const result = validator.validate(value, childPath);
        if (result.ok) {
          if (result.value !== undefined) out[key] = result.value;
        } else {
          issues.push(...result.issues);
        }
      }
      // Undeclared keys are dropped here, and this is the entire point of the package.
      return issues.length > 0 ? { ok: false, issues } : ok(out as ObjectType<S>);
    },
  };
}

function typeName(input: unknown): string {
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  return typeof input;
}
