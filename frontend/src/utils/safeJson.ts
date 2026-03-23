/**
 * Safely parse JSON from localStorage without prototype pollution.
 * Strips __proto__, constructor, and prototype keys from the parsed object.
 */
export function safeJsonParse<T>(raw: string): T {
  return JSON.parse(raw, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      return undefined;
    return value;
  }) as T;
}

/**
 * Pick only known keys from a parsed object, validating each value's type.
 * Returns a new object with only the allowed keys whose values match the
 * expected type (inferred from the defaults object).
 */
export function pickValid<T extends Record<string, unknown>>(
  parsed: unknown,
  defaults: T,
): T {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ...defaults };
  }
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const val = (parsed as Record<string, unknown>)[key as string];
    if (typeof val === typeof defaults[key]) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}
