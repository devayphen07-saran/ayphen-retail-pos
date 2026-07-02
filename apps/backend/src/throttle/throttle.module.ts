import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name:  'global',
          ttl:   60_000,
          limit: 100,
        },
      ],
    }),
  ],
})
export class ThrottleModule {}
