import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class RegisterUserDto {
  @ApiProperty({
    description: 'Unique login identifier for the account.',
    minLength: 1,
    maxLength: 254,
    example: 'jane.doe',
  })
  @IsString()
  @Length(1, 254)
  login!: string;

  @ApiProperty({
    description: 'Account password.',
    minLength: 8,
    maxLength: 128,
    example: 's3cretPass',
  })
  @IsString()
  @Length(8, 128)
  password!: string;
}
