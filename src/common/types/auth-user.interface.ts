import { Role } from './role.enum';

export interface AuthUser {
  id: string;
  role: Role;
}
