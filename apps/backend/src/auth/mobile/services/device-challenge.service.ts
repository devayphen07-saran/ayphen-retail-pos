import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { MOBILE_REDIS } from './redis.provider.js';
import { AuthConstantsService } from '../../core/auth-constants.service.js';

const challengeKey = (id: string) => `device_challenge:${id}`;

@Injectable()
export class DeviceChallengeService {
  constructor(
    @Inject(MOBILE_REDIS) private readonly redis: Redis,
    private readonly constants: AuthConstantsService,
  ) {}

  async issueChallenge(deviceId: string): Promise<string> {
    const challengeId = randomUUID();
    await this.redis.setex(
      challengeKey(challengeId),
      this.constants.DEVICE_CHALLENGE_TTL_SECONDS,
      deviceId,
    );
    return challengeId;
  }

  async consumeChallenge(challengeId: string): Promise<string> {
    const deviceId = await this.redis.getdel(challengeKey(challengeId));
    if (!deviceId) {
      throw new UnauthorizedException('CHALLENGE_NOT_FOUND');
    }
    return deviceId;
  }
}
