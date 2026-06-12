import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class UpdateUserDto {
  @ApiPropertyOptional({
    description: 'New login identifier for the account.',
    minLength: 1,
    maxLength: 254,
    example: 'jane.doe',
  })
  @IsOptional()
  @IsString()
  @Length(1, 254)
  login?: string;

  @ApiPropertyOptional({
    description: 'New account password.',
    minLength: 8,
    maxLength: 128,
    example: 'n3wPassword',
  })
  @IsOptional()
  @IsString()
  @Length(8, 128)
  password?: string;
}
