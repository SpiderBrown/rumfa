import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

/** Shared by main.ts and the e2e tests so both run the same pipeline. */
export function setupApp(app: INestApplication): void {
  const config = app.get(ConfigService);
  (app as NestExpressApplication).set('trust proxy', 1);
  // Party logos (up to 2 MB) and voter CSVs from Rumfa Console are bigger than the default 100 KB
  (app as NestExpressApplication).useBodyParser('json', { limit: '10mb' });
  app.use(helmet({ contentSecurityPolicy: false }));
  const origins = config.get<string[]>('corsOrigins')!;
  app.enableCors({ origin: origins.includes('*') ? true : origins, credentials: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();
  if (config.get('env') !== 'production') {
    const doc = new DocumentBuilder().setTitle('Rumfa API').setVersion('1').addBearerAuth().build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }
}
