import { Body, Controller, Get, HttpCode, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { CurrentUser, Public, Roles } from './decorators';
import type { AuthUser } from './auth.types';
import { TokensService } from './tokens.service';
import {
  AcceptInviteDto, ActivationRequestDto, ActivationVerifyDto, MfaDto, PinLoginDto, RefreshDto, SelectTenantDto,
  StaffLoginDto, SwitchTenantDto, TotpCodeDto, TotpEnableDto, TotpSetupDto,
} from './dto';

@ApiTags('Sign-in')
@Controller('auth')
@Throttle({ default: { ttl: 60_000, limit: 30 } })
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly tokens: TokensService) {}

  @Public() @Post('activate/request') @HttpCode(200)
  @ApiOperation({ summary: 'Send an activation code to a phone by SMS or WhatsApp' })
  request(@Body() dto: ActivationRequestDto, @Ip() ip: string) {
    return this.auth.requestActivation(dto.phone, dto.channel, ip);
  }

  @Public() @Post('activate/verify') @HttpCode(200)
  @ApiOperation({ summary: 'Activate this phone with the code (or a coordinator activation code) and set the PIN' })
  verify(@Body() dto: ActivationVerifyDto, @Ip() ip: string) {
    return this.auth.verifyActivation(dto, ip);
  }

  @Public() @Post('pin') @HttpCode(200)
  @ApiOperation({ summary: 'Daily sign-in: phone + PIN on an activated phone' })
  pin(@Body() dto: PinLoginDto, @Ip() ip: string) {
    return this.auth.pinLogin(dto, ip);
  }

  @Public() @Post('select-tenant') @HttpCode(200)
  @ApiOperation({ summary: 'Pick which organisation to work for after signing in' })
  select(@Body() dto: SelectTenantDto) {
    return this.auth.selectTenant(dto.selectToken, dto.tenantId);
  }

  @ApiBearerAuth() @Post('switch-tenant') @HttpCode(200)
  @ApiOperation({ summary: 'Switch to another organisation on the same phone' })
  switch(@CurrentUser() user: AuthUser, @Body() dto: SwitchTenantDto) {
    return this.auth.switchTenant(user, dto.tenantId);
  }

  @Public() @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.tokens.refresh(dto.refreshToken);
  }

  @Public() @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.tokens.revoke(dto.refreshToken);
  }

  @Public() @Post('login') @HttpCode(200)
  @ApiOperation({ summary: 'Dashboard sign-in with email and password' })
  login(@Body() dto: StaffLoginDto, @Ip() ip: string) {
    return this.auth.staffLogin(dto, ip);
  }

  @Public() @Post('mfa') @HttpCode(200)
  @ApiOperation({ summary: 'Second step: authenticator code' })
  mfa(@Body() dto: MfaDto) {
    return this.auth.mfa(dto.mfaToken, dto.code);
  }

  @Public() @Post('totp/setup') @HttpCode(200)
  @ApiOperation({ summary: 'First sign-in of a role that needs an authenticator: get the secret / QR link' })
  totpSetup(@Body() dto: TotpSetupDto) {
    return this.auth.totpSetupWithToken(dto.setupToken);
  }

  @Public() @Post('totp/enable') @HttpCode(200)
  totpEnable(@Body() dto: TotpEnableDto) {
    return this.auth.totpEnableWithToken(dto.setupToken, dto.code);
  }

  @ApiBearerAuth() @Post('me/totp/setup') @HttpCode(200)
  @ApiOperation({ summary: 'Optional: add an authenticator to your account' })
  myTotpSetup(@CurrentUser() user: AuthUser) {
    return this.auth.totpSetup(user.sub);
  }

  @ApiBearerAuth() @Post('me/totp/enable') @HttpCode(204)
  async myTotpEnable(@CurrentUser() user: AuthUser, @Body() dto: TotpCodeDto) {
    await this.auth.totpEnable(user.sub, dto.code);
  }

  @Public() @Post('invite/accept') @HttpCode(200)
  @ApiOperation({ summary: 'Staff invite link: set a password' })
  accept(@Body() dto: AcceptInviteDto) {
    return this.auth.acceptInvite(dto.token, dto.password);
  }

  @ApiBearerAuth() @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }
}

@ApiTags('People access')
@ApiBearerAuth()
@Controller('people/:id')
export class AccessController {
  constructor(private readonly auth: AuthService) {}

  @Post('activation-code') @Roles('coordinator', 'admin')
  @ApiOperation({ summary: 'One-time activation code for a field user (valid 48 hours)' })
  code(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.issueActivationCode(user, id);
  }

  @Post('invite') @Roles('admin')
  @ApiOperation({ summary: 'Invite link for a dashboard staff member (valid 7 days)' })
  invite(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.inviteStaff(user, id);
  }

  @Post('devices/revoke') @HttpCode(200) @Roles('coordinator', 'admin')
  @ApiOperation({ summary: 'Lost or stolen phone: sign it out everywhere' })
  revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.revokeDevices(user, id);
  }
}
