import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { RequestWithUser } from '../auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth';
import { AuthUser, Role } from '../common/types';
import { ChangeRoleDto, UpdateUserDto } from '../dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update the authenticated user's own profile" })
  @ApiResponse({ status: 200, description: 'Profile updated successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid payload.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Cannot update another user.' })
  updateOwnProfile(
    @Req() request: RequestWithUser,
    @Body() dto: UpdateUserDto,
  ): void {
    const user = request.user as AuthUser;
    this.usersService.updateOwnProfile(user, user.id, dto);
  }

  @Patch(':id/role')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change a user's role (administrator only)" })
  @ApiResponse({ status: 200, description: 'Role changed successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid role value or malformed id.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Insufficient privileges or self role change.' })
  @ApiResponse({ status: 404, description: 'Target user not found.' })
  changeRole(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRoleDto,
  ): void {
    const actor = request.user as AuthUser;
    this.usersService.changeRole(actor, id, dto.role);
  }
}