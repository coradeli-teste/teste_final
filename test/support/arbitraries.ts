/**
 * Reusable fast-check arbitraries (generators) for the Event Ticket Reservation
 * property tests. Sibling test tasks (13.x–18.x) should import generators from
 * here rather than redefining input spaces, so the validation bounds stay in
 * one place and match the requirements/design.
 *
 * Strings are generated from the printable-ASCII range (0x20–0x7E). This keeps
 * generated values deterministic and round-trip-safe through SQLite TEXT
 * columns (no embedded NULs or lone surrogates), while still exercising spaces,
 * digits, punctuation, and mixed case for "verbatim storage" assertions.
 */
import fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';

/** A single printable-ASCII character (space through tilde). */
const printableAsciiChar = fc
  .integer({ min: 0x20, max: 0x7e })
  .map((code) => String.fromCharCode(code));

/**
 * Build a printable-ASCII string whose length (in characters) falls within the
 * inclusive `[minLength, maxLength]` bounds.
 */
export function asciiStringOfLength(
  minLength: number,
  maxLength: number,
): fc.Arbitrary<string> {
  return fc
    .array(printableAsciiChar, { minLength, maxLength })
    .map((chars) => chars.join(''));
}

/**
 * A valid registration login: 1–254 printable-ASCII characters (Requirement
 * 1.1). Note: this does NOT guarantee uniqueness across generated cases — use
 * {@link uniqueValidLogin} when a test must avoid the active-login uniqueness
 * conflict (HTTP 409, Requirement 1.4).
 */
export const validLoginArbitrary: fc.Arbitrary<string> = asciiStringOfLength(
  1,
  254,
);

/**
 * A valid registration password: 8–128 printable-ASCII characters
 * (Requirement 1.1), suitable for byte-for-byte verbatim-storage assertions
 * (Requirement 1.2).
 */
export const validPasswordArbitrary: fc.Arbitrary<string> = asciiStringOfLength(
  8,
  128,
);

/**
 * A valid login that is globally unique per generated case while remaining
 * within the 1–254 character bound.
 *
 * Tests that register many users against a single shared database need each
 * login to be distinct, otherwise the second registration with a repeated
 * login is (correctly) rejected with HTTP 409. This composes a fresh UUID (36
 * chars) with up to 200 generated printable-ASCII characters and truncates to
 * 254, so the result is always a valid, unique login.
 */
export const uniqueValidLogin: fc.Arbitrary<string> = asciiStringOfLength(
  0,
  200,
).map((suffix) => `${uuidv4()}-${suffix}`.slice(0, 254));
