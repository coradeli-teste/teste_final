import { SetMetadata } from '@nestjs/common';
import { Role } from '../../common/types';

export const ROLES_KEY = 'requiredRoles';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);