// Unit test for the 30-second timeout criterion (Task 18.1, Req 14.6).
//
// Testing a real 30-second wait is impractical, so this test drives the
// TimeoutInterceptor directly with Jest fake timers: a CallHandler whose
// observable emits only AFTER the configured timeout must be mapped to a
// RequestTimeoutException (HTTP 408), while a handler that emits BEFORE the
// timeout passes through untouched. No real time elapses.

import { RequestTimeoutException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { timer } from 'rxjs';

import {
  REQUEST_TIMEOUT_MS,
  TimeoutInterceptor,
} from '../../src/common/interceptors/timeout.interceptor';

/** A minimal ExecutionContext stand-in; the interceptor does not read it. */
const fakeContext = {} as ExecutionContext;

describe('TimeoutInterceptor (Req 14.6) — 30s timeout maps to HTTP 408', () => {
  let interceptor: TimeoutInterceptor;

  beforeEach(() => {
    jest.useFakeTimers();
    interceptor = new TimeoutInterceptor();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('maps a handler that exceeds REQUEST_TIMEOUT_MS to RequestTimeoutException (408)', () => {
    // Handler emits 1 second after the timeout window — i.e. it never makes it.
    const next: CallHandler = {
      handle: () => timer(REQUEST_TIMEOUT_MS + 1000),
    };

    let emitted = false;
    let caught: unknown;
    let completed = false;

    const subscription = interceptor
      .intercept(fakeContext, next)
      .subscribe({
        next: () => {
          emitted = true;
        },
        error: (error) => {
          caught = error;
        },
        complete: () => {
          completed = true;
        },
      });

    // Advance virtual time past the timeout; this fires the timeout operator.
    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS + 1000);

    expect(emitted).toBe(false);
    expect(completed).toBe(false);
    expect(caught).toBeInstanceOf(RequestTimeoutException);
    expect((caught as RequestTimeoutException).getStatus()).toBe(408);

    subscription.unsubscribe();
  });

  it('lets a handler that completes within the timeout pass through unchanged', () => {
    // Handler emits well before the timeout window.
    const next: CallHandler = {
      handle: () => timer(REQUEST_TIMEOUT_MS - 1000),
    };

    let emittedValue: unknown;
    let caught: unknown;
    let completed = false;

    const subscription = interceptor
      .intercept(fakeContext, next)
      .subscribe({
        next: (value) => {
          emittedValue = value;
        },
        error: (error) => {
          caught = error;
        },
        complete: () => {
          completed = true;
        },
      });

    jest.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1000);

    // The value passed through with no timeout error.
    expect(caught).toBeUndefined();
    expect(emittedValue).toBe(0); // timer(...) emits 0 once
    expect(completed).toBe(true);

    subscription.unsubscribe();
  });
});
