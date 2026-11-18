import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class ActivationRequestDto {
  @ApiProperty({ example: '08031234567' }) @IsString() @MaxLength(20) phone: string;
  @ApiProperty({ enum: ['sms', 'whatsapp'] }) @IsIn(['sms', 'whatsapp']) channel: 'sms' | 'whatsapp';
}

export class ActivationVerifyDto {
  @ApiProperty() @IsString() @MaxLength(20) phone: string;
  @ApiPropertyOptional({ description: 'Code received by SMS or WhatsApp' }) @IsOptional() @Matches(/^\d{6}$/) code?: string;
  @ApiPropertyOptional({ description: 'Activation code from the coordinator' }) @IsOptional() @IsString() @MaxLength(16) activationCode?: string;
  @ApiProperty({ description: 'New 6-digit PIN for daily sign-in' }) @Matches(/^\d{6}$/) pin: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) deviceName?: string;
  @ApiProperty({ enum: ['android', 'ios', 'web'] }) @IsIn(['android', 'ios', 'web']) platform: 'android' | 'ios' | 'web';
  @ApiPropertyOptional() @IsOptional() @IsUUID() tenantId?: string;
}

export class PinLoginDto {
  @ApiProperty() @IsString() @MaxLength(20) phone: string;
  @ApiProperty() @Matches(/^\d{6}$/) pin: string;
  @ApiProperty() @IsUUID() deviceId: string;
  @ApiProperty() @IsString() @Length(20, 100) deviceSecret: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() tenantId?: string;
}

export class SelectTenantDto {
  @ApiProperty() @IsString() selectToken: string;
  @ApiProperty() @IsUUID() tenantId: string;
}

export class SwitchTenantDto {
  @ApiProperty() @IsUUID() tenantId: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @MaxLength(200) refreshToken: string;
}

export class StaffLoginDto {
  @ApiProperty() @IsString() @MaxLength(200) email: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
  @ApiProperty({ description: "The dashboard site's tenant (from its config)" }) @IsUUID() tenantId: string;
}

export class AcceptInviteDto {
  @ApiProperty() @IsString() @MaxLength(200) token: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) @MaxLength(200) password: string;
}

export class SupportTicketDto {
  @ApiProperty() @IsString() @MaxLength(200) ticket: string;
}
