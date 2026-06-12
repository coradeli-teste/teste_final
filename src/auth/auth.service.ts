import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { LoginDto } from '../dto';
import { Role } from '../common/types';

const TOKEN_TTL_SECONDS = 3600;

interface JwtSignPayload {
  sub: string;
  role: Role;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  login(dto: LoginDto): { accessToken: string } {
    const secret = this.configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException(
        'Authentication service is unavailable',
      );
    }

    const user = this.usersService.findByLogin(dto.login);
    if (!user || user.password !== dto.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const payload: JwtSignPayload = { sub: user.id, role: user.role };
    const accessToken = this.jwtService.sign(payload, {
      secret,
      expiresIn: TOKEN_TTL_SECONDS,
    });

    return { accessToken };
  }
}