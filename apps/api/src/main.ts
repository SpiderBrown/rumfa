import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  setupApp(app);
  const config = app.get(ConfigService);
  const port = config.get<number>('port')!;
  await app.listen(port, '0.0.0.0');
  const log = new Logger('Bootstrap');
  log.log(`Rumfa API on http://localhost:${port}/api/v1 (${config.get('env')})`);
  if (config.get('env') !== 'production') log.log(`API docs: http://localhost:${port}/api/docs`);
  if (config.get('auth.otpMode') !== 'sms') log.warn(`OTP_MODE=${config.get('auth.otpMode')}: codes are not sent by SMS`);
}
void bootstrap();
