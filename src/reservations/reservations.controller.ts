import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { RequestWithUser } from '../auth/guards/jwt-auth.guard';
import type { AuthUser } from '../common/types';
import { ReservationHistoryEntry } from '../dto';
import { ReservationsService } from './reservations.service';

@ApiTags('reservations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post('events/:id/reservations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Reserve a seat for an event' })
  @ApiCreatedResponse({
    description: 'Reservation created.',
    schema: {
      type: 'object',
      properties: {
        reservationId: { type: 'string', example: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' },
        remainingSeats: { type: 'integer', example: 41 },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Malformed event identifier or event already started.' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication is required.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Event not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Event cancelled, sold out, or duplicate reservation.' })
  reserve(
    @Param('id', ParseUUIDPipe) eventId: string,
    @Req() request: RequestWithUser,
  ): { reservationId: string; remainingSeats: number } {
    const user = request.user as AuthUser;
    return this.reservationsService.reserve(user, eventId);
  }

  @Delete('reservations/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a reservation' })
  @ApiOkResponse({ description: 'Reservation cancelled and seat returned.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Malformed reservation identifier.' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication is required.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'The reservation belongs to a different user.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Reservation not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Reservation is already cancelled.' })
  @ApiResponse({ status: HttpStatus.INTERNAL_SERVER_ERROR, description: 'Unexpected server error.' })
  cancel(
    @Param('id', ParseUUIDPipe) reservationId: string,
    @Req() request: RequestWithUser,
  ): void {
    const user = request.user as AuthUser;
    this.reservationsService.cancel(user, reservationId);
  }

  @Get('reservations/me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List my reservation history' })
  @ApiOkResponse({
    description: "The authenticated user's reservation history.",
    type: ReservationHistoryEntry,
    isArray: true,
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication is required.' })
  history(@Req() request: RequestWithUser): ReservationHistoryEntry[] {
    const user = request.user as AuthUser;
    return this.reservationsService.history(user);
  }
}
