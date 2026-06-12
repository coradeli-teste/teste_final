import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../database/database.service';
import { AuthUser, Role, UserRow } from '../common/types';
import { RegisterUserDto, UpdateUserDto } from '../dto';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  register(dto: RegisterUserDto): { id: string } {
    const existing = this.db.get<{ id: string }>(
      `SELECT id FROM users WHERE login = ? AND status = 'active'`,
      [dto.login],
    );
    if (existing) {
      throw new ConflictException('Login already in use');
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO users (id, login, password, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [id, dto.login, dto.password, Role.BUYER, now, now],
    );

    return { id };
  }

  findByLogin(login: string): UserRow | undefined {
    return this.db.get<UserRow>(
      `SELECT id,
              login,
              password,
              role,
              status,
              created_at AS createdAt,
              updated_at AS updatedAt
         FROM users
        WHERE login = ? AND status = 'active'`,
      [login],
    );
  }

  findById(id: string): UserRow | undefined {
    return this.db.get<UserRow>(
      `SELECT id,
              login,
              password,
              role,
              status,
              created_at AS createdAt,
              updated_at AS updatedAt
         FROM users
        WHERE id = ?`,
      [id],
    );
  }

  changeRole(actor: AuthUser, targetUserId: string, role: Role): void {
    if (actor.role !== Role.ADMINISTRATOR) {
      throw new ForbiddenException('Only administrators can change user roles');
    }

    if (targetUserId === actor.id) {
      throw new ForbiddenException('Cannot change your own role');
    }

    const isInEnum =
      role === Role.BUYER ||
      role === Role.ORGANIZER ||
      role === Role.ADMINISTRATOR;
    if (!isInEnum) {
      throw new BadRequestException('Role is not within the allowed values');
    }

    const target = this.db.get<{ id: string }>(
      `SELECT id FROM users WHERE id = ?`,
      [targetUserId],
    );
    if (!target) {
      throw new NotFoundException('User not found');
    }

    const now = new Date().toISOString();
    this.db.run(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, [
      role,
      now,
      targetUserId,
    ]);
  }

  updateOwnProfile(
    actor: AuthUser,
    targetUserId: string,
    dto: UpdateUserDto,
  ): void {
    if (targetUserId !== actor.id) {
      throw new ForbiddenException('Cannot update another user\'s profile');
    }

    const assignments: string[] = [];
    const params: unknown[] = [];

    if (dto.login !== undefined) {
      assignments.push('login = ?');
      params.push(dto.login);
    }
    if (dto.password !== undefined) {
      assignments.push('password = ?');
      params.push(dto.password);
    }

    if (assignments.length === 0) {
      return;
    }

    assignments.push('updated_at = ?');
    params.push(new Date().toISOString());

    params.push(targetUserId);

    this.db.run(
      `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`,
      params,
    );
  }
}