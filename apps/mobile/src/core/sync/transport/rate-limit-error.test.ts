import { AxiosError, AxiosHeaders } from 'axios';
import { RateLimitedError, rethrowIfRateLimited } from './rate-limit-error';

function fakeAxios429(retryAfterHeader: string | undefined): AxiosError {
  const headers = new AxiosHeaders();
  if (retryAfterHeader !== undefined) headers.set('retry-after', retryAfterHeader);
  return new AxiosError('Too Many Requests', undefined, undefined, undefined, {
    status: 429,
    statusText: 'Too Many Requests',
    headers,
    config: {} as never,
    data: undefined,
  });
}

describe('rethrowIfRateLimited', () => {
  it('classifies a 429 with a valid Retry-After header into RateLimitedError with the exact ms', () => {
    expect(() => rethrowIfRateLimited(fakeAxios429('5'))).toThrow(RateLimitedError);
    try {
      rethrowIfRateLimited(fakeAxios429('5'));
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(5000);
    }
  });

  it('falls back to the default when the header is missing', () => {
    try {
      rethrowIfRateLimited(fakeAxios429(undefined));
      fail('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(30_000);
    }
  });

  it('falls back to the default when the header is unparseable', () => {
    try {
      rethrowIfRateLimited(fakeAxios429('not-a-number'));
      fail('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).retryAfterMs).toBe(30_000);
    }
  });

  it('passes every non-429 error through unchanged', () => {
    const notRateLimited = new Error('offline');
    expect(() => rethrowIfRateLimited(notRateLimited)).toThrow(notRateLimited);

    const other4xx = new AxiosError('Forbidden', undefined, undefined, undefined, {
      status: 403,
      statusText: 'Forbidden',
      headers: new AxiosHeaders(),
      config: {} as never,
      data: undefined,
    });
    expect(() => rethrowIfRateLimited(other4xx)).toThrow(other4xx);
  });
});
