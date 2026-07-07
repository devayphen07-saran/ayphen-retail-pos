import { AxiosError, AxiosHeaders } from 'axios';
import { isPoisonPushError } from './push-error-classifier';
import { RateLimitedError } from './rate-limit-error';

function fakeAxiosStatus(status: number): AxiosError {
  return new AxiosError('failed', undefined, undefined, undefined, {
    status,
    statusText: 'error',
    headers: new AxiosHeaders(),
    config: {} as never,
    data: undefined,
  });
}

describe('isPoisonPushError', () => {
  it('is NOT poison for a plain/unrecognized error (e.g. a raw network failure)', () => {
    expect(isPoisonPushError(new Error('Network Error'))).toBe(false);
  });

  it('is NOT poison for an axios error with no response (offline/timeout/DNS failure)', () => {
    const noResponse = new AxiosError('timeout', 'ECONNABORTED');
    expect(isPoisonPushError(noResponse)).toBe(false);
  });

  it('is NOT poison for a 5xx — the server\'s fault, not the mutation\'s', () => {
    expect(isPoisonPushError(fakeAxiosStatus(500))).toBe(false);
    expect(isPoisonPushError(fakeAxiosStatus(503))).toBe(false);
  });

  it('is NOT poison for a 429 — rate-limiting is transient, not a rejection', () => {
    expect(isPoisonPushError(fakeAxiosStatus(429))).toBe(false);
  });

  it('is NOT poison for a RateLimitedError (the classified form 429 arrives as)', () => {
    expect(isPoisonPushError(new RateLimitedError(5000))).toBe(false);
  });

  it('IS poison for a non-429 4xx — the server flatly rejected the batch payload', () => {
    expect(isPoisonPushError(fakeAxiosStatus(400))).toBe(true);
    expect(isPoisonPushError(fakeAxiosStatus(403))).toBe(true);
    expect(isPoisonPushError(fakeAxiosStatus(422))).toBe(true);
  });
});