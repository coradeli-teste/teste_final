import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt } from 'class-validator';
import { Role } from '../../common/types';

export class ChangeRoleDto {
  @ApiProperty({
    description: 'Target role value (0 = BUYER, 1 = ORGANIZER, 2 = ADMINISTRATOR).',
    enum: Role,
    example: Role.ORGANIZER,
  })
  @IsInt()
  @IsEnum(Role)
  role!: Role;
}
