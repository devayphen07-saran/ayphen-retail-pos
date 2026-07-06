import {
  DocumentBuilder,
  type OpenAPIObject,
  type SwaggerCustomOptions,
} from '@nestjs/swagger';
import { env } from './env';

export const swaggerDocConfig = new DocumentBuilder()
  .setTitle('Ayphen Retail POS')
  .setDescription('REST API for the retail point-of-sale backend')
  .setVersion('1.0')
  .addServer(`http://localhost:${env.PORT}`, 'Local dev')
  .addBearerAuth(
    {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      name: 'Authorization',
      in: 'header',
    },
    'access-token',
  )
  .build();

export const swaggerUiOptions: SwaggerCustomOptions = {
  swaggerOptions: { persistAuthorization: true },
};

export type { OpenAPIObject };
