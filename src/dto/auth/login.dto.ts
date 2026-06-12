import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'Login identifier of the account.',
    example: 'jane.doe',
  })
  @IsString()
  @IsNotEmpty()
  login!: string;

  @ApiProperty({
    description: 'Account password.',
    example: 's3cretPass',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
