import { Role } from './role.enum';
import { EntityStatus } from './entity-status.type';

export interface UserRow {
  id: string;
  login: string;
  password: string;
  role: Role;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EventRow {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  startDate: string;
  totalSeats: number;
  remainingSeats: number;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationRow {
  id: string;
  userId: string;
  eventId: string;
  status: EntityStatus;
  eventStatusSnapshot: EntityStatus;
  createdAt: string;
  updatedAt: string;
}
