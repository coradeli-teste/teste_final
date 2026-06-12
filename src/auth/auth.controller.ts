import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from '../dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in and obtain a JWT session token' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Credentials accepted; returns a signed access token.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload failed validation.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Credentials do not match any stored user record.',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Signing secret is missing; service unavailable.',
  })
  login(@Body() dto: LoginDto): { accessToken: string } {
    return this.authService.login(dto);
  }
}