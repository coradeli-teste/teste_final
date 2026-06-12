import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthUser, Role } from '../../common/types';

export interface JwtPayload {
  sub: string;
  role: Role;
  iat: number;
  exp: number;
}

export interface RequestWithUser extends Request {
  user?: AuthUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Authentication is required');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Authentication is required');
    }

    request.user = { id: payload.sub, role: payload.role };
    return true;
  }

  private extractBearerToken(request: RequestWithUser): string | undefined {
    const header = request.headers?.authorization;
    if (typeof header !== 'string') {
      return undefined;
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return undefined;
    }

    return token;
  }
}