import { ApiProperty } from '@nestjs/swagger';

export class ApiEnvelope<T> {
  @ApiProperty({
    description: 'Indicates the request succeeded.',
    example: true,
  })
  success!: boolean;

  @ApiProperty({
    description: 'The handler result payload.',
  })
  data!: T;

  @ApiProperty({
    description: 'Trace identifier (UUID) correlating this response with its request.',
    example: '7b4f6c1a-2e3d-4a5b-8c9d-0e1f2a3b4c5d',
  })
  traceId!: string;

  @ApiProperty({
    description: 'ISO-8601 timestamp of when the response was produced.',
    example: '2025-01-01T12:00:00.000Z',
  })
  timestamp!: string;
}
