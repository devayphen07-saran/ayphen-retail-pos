import postgres from 'postgres';
import { AuthLoginService } from '../../../src/auth/mobile/services/auth-login.service.js';
import { AuthMapper } from '../../../src/auth/mobile/mappers/auth.mapper.js';
import { ConflictError } from '../../../src/common/exceptions/app.exception.js';
import type { UserRepository } from '../../../src/auth/mobile/repositories/user.repository.js';
import type { ProfileResult, LoginResult, BootstrapResult } from '../../../src/auth/mobile/types/auth-result.js';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const FULL_PROFILE: ProfileResult = {
  name:              'Asha Rao',
  email:             'asha@example.com',
  phone:             '9999999999',
  phoneVerified:     true,
  profilePictureUrl: 'https://cdn.example.com/avatars/asha.jpg',
};

function makeService(findProfile: (id: string) => Promise<ProfileResult | null>): AuthLoginService {
  const userRepo: Partial<UserRepository> = { findProfile };
  // getProfile() only touches userRepo — every other dependency is unused by
  // this method, so it's safe to stub (same pattern as StoreService/
  // ReconciliationService's unit tests: only mock what the method under test
  // actually calls).
  return new AuthLoginService(
    userRepo as UserRepository,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
  );
}

function makeServiceWithRepo(userRepo: Partial<UserRepository>): AuthLoginService {
  return new AuthLoginService(
    userRepo as UserRepository,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never,
  );
}

describe('AuthLoginService.getProfile', () => {
  it('delegates to UserRepository.findProfile with the given userId', async () => {
    const findProfile = jest.fn(async (id: string) => (id === USER_ID ? FULL_PROFILE : null));
    const service = makeService(findProfile);

    const result = await service.getProfile(USER_ID);

    expect(findProfile).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual(FULL_PROFILE);
  });

  it('returns null when the user has no row (caller maps this to 404, never a client-supplied id)', async () => {
    const service = makeService(async () => null);
    await expect(service.getProfile(USER_ID)).resolves.toBeNull();
  });
});

describe('AuthMapper.toProfileResponse', () => {
  it('maps camelCase domain fields to the snake_case wire contract', () => {
    expect(AuthMapper.toProfileResponse(FULL_PROFILE)).toEqual({
      name:                'Asha Rao',
      email:               'asha@example.com',
      phone:               '9999999999',
      phone_verified:      true,
      profile_picture_url: 'https://cdn.example.com/avatars/asha.jpg',
    });
  });

  it('passes through null email/phone/picture as null, not undefined or empty string', () => {
    const phoneOnlySignup: ProfileResult = {
      name:              'Ravi Kumar',
      email:             null,
      phone:             '8888888888',
      phoneVerified:     true,
      profilePictureUrl: null,
    };
    const response = AuthMapper.toProfileResponse(phoneOnlySignup);
    expect(response.email).toBeNull();
    expect(response.profile_picture_url).toBeNull();
  });
});

describe('AuthLoginService.updateProfile', () => {
  it('writes the patch then returns the fresh profile', async () => {
    const updateProfile = jest.fn(async () => undefined);
    const findProfile = jest.fn(async () => FULL_PROFILE);
    const service = makeServiceWithRepo({ updateProfile, findProfile });

    const result = await service.updateProfile(USER_ID, { email: 'asha@example.com' });

    expect(updateProfile).toHaveBeenCalledWith(USER_ID, { email: 'asha@example.com' });
    expect(result).toEqual(FULL_PROFILE);
  });

  it('translates a unique-email collision (23505) into a 409, not a raw DB error', async () => {
    // The runtime constructor accepts an options object and Object.assign()s
    // it onto the instance (postgres.js's errors.js), but its .d.ts only
    // types a plain string message — go through Object.assign to satisfy both.
    const pgError = Object.assign(
      new postgres.PostgresError('duplicate key value violates unique constraint "users_email_unique"'),
      { code: '23505' },
    );
    const updateProfile = jest.fn(async () => {
      throw pgError;
    });
    const service = makeServiceWithRepo({ updateProfile, findProfile: jest.fn() });

    await expect(
      service.updateProfile(USER_ID, { email: 'taken@example.com' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rethrows an unrelated DB error unchanged (not mistaken for an email collision)', async () => {
    const updateProfile = jest.fn(async () => {
      throw new Error('connection reset');
    });
    const service = makeServiceWithRepo({ updateProfile, findProfile: jest.fn() });

    await expect(
      service.updateProfile(USER_ID, { name: 'New Name' }),
    ).rejects.toThrow('connection reset');
  });
});

describe('profileComplete derivation (LoginResult/BootstrapResult)', () => {
  // loginStageTwo/bootstrap() compute `profileComplete: user.email !== null`
  // straight off the already-loaded user row (see auth-login.service.ts) —
  // these tests pin the contract at the mapper boundary, which is what the
  // mobile AppGate gate actually reads off the wire.
  it('toLoginResponse passes profile_complete through unchanged', () => {
    const result: LoginResult = {
      accessToken: 't', refreshToken: 'r', deviceSessionId: 'd',
      snapshot: null, snapshotSignature: null,
      lastAccountMode: null, pendingInvitationCount: 0,
      profileComplete: false,
    };
    expect(AuthMapper.toLoginResponse(result).profile_complete).toBe(false);
  });

  it('toBootstrapResponse passes profile_complete through unchanged', () => {
    const result: BootstrapResult = {
      deviceSessionId: 'd',
      snapshot: { userId: 'u', permissionsVersion: 1, generatedAt: 'now', stores: [] },
      snapshotSignature: 'sig',
      lastAccountMode: 'business', pendingInvitationCount: 0,
      profileComplete: true,
    };
    expect(AuthMapper.toBootstrapResponse(result).profile_complete).toBe(true);
  });
});
