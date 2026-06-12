import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles, RolesGuard } from '../auth';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { RequestWithUser } from '../auth/guards/jwt-auth.guard';
import { AuthUser, Role } from '../common/types';
import { CreateEventDto, EventView, UpdateEventDto } from '../dto';
import { EventsService } from './events.service';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create an event (organizer or administrator).' })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Event created.', type: EventView })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid payload.' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient privileges.' })
  create(@Req() request: RequestWithUser, @Body() dto: CreateEventDto): EventView {
    const user = request.user as AuthUser;
    return this.eventsService.create(user, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update an event (owning organizer only).' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Event updated.', type: EventView })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid payload or malformed identifier.' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient privileges or not the owner.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Event not found.' })
  update(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEventDto,
  ): EventView {
    const user = request.user as AuthUser;
    return this.eventsService.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ORGANIZER, Role.ADMINISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel an event (owning organizer or administrator).' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Event cancelled.' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Malformed identifier.' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Authentication required.' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Insufficient privileges or not the owner.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Event not found.' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Event is already cancelled.' })
  cancel(
    @Req() request: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): void {
    const user = request.user as AuthUser;
    this.eventsService.cancel(user, id);
  }

  @Get()
  @ApiOperation({ summary: 'List active events.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Active events.', type: EventView, isArray: true })
  listActive(): EventView[] {
    return this.eventsService.listActive();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a single event by identifier.' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Event found.', type: EventView })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Malformed identifier.' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Event not found.' })
  getById(@Param('id', ParseUUIDPipe) id: string): EventView {
    return this.eventsService.getById(id);
  }
}
