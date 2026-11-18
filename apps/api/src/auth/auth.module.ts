import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AccessController, AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AddonGuard, JwtAuthGuard, RolesGuard } from './guards';
import { OtpSender } from './otp-sender.service';
import { TokensService } from './tokens.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, AccessController],
  providers: [
    AuthService, TokensService, OtpSender,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: AddonGuard },
  ],
  exports: [TokensService],
})
export class AuthModule {}
