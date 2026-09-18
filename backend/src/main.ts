import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, raw, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({ origin: true, credentials: true });

  // Stripe signature verification needs the untouched raw body, so this route
  // must be registered before the global JSON body parser.
  app.use('/api/webhooks/stripe', raw({ type: '*/*' }));
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: true }));

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false }),
  );

  const port = Number(process.env.PORT ?? 3123);
  await app.listen(port);
  new Logger('Bootstrap').log(`OptiSigns billing demo API listening on http://localhost:${port}/api`);
}

void bootstrap();
