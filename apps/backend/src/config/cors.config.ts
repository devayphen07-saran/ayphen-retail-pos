import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { env } from './env';

const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim());

export const corsConfig: CorsOptions = {
  origin: (
    requestOrigin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin '${requestOrigin}' is not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-request-id',
    'Idempotency-Key',
  ],
  exposedHeaders: ['x-request-id'],
  maxAge: 86_400,
};
