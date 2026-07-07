import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { UnauthorizedError } from '#common/exceptions/app.exception.js';
import { ErrorCodes } from '#common/error-codes.js';
import { REDIS } from '#common/redis/redis.provider.js';
import { AppConfigService } from '#config/app-config.service.js';

const challengeKey = (id: string) => `device_challenge:${id}`;

@Injectable()
export class DeviceChallengeService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: AppConfigService,
  ) {}

  async issueChallenge(deviceId: string): Promise<string> {
    const challengeId = randomUUID();
    await this.redis.setex(
      challengeKey(challengeId),
      this.config.deviceChallengeTtlSeconds,
      deviceId,
    );
    return challengeId;
  }

  async consumeChallenge(challengeId: string): Promise<string> {
    const deviceId = await this.redis.getdel(challengeKey(challengeId));
    if (!deviceId) {
      throw new UnauthorizedError(ErrorCodes.CHALLENGE_NOT_FOUND, 'Device challenge not found or expired');
    }
    return deviceId;
  }
}
