import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnvironment } from './config/env.validation';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { ResponseTransformInterceptor } from './common/interceptors/response-transform.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { TraceIdMiddleware } from './common/middleware/trace-id.middleware';
import { DatabaseModule } from './database/database.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';


@Module({
  imports: [
    ConfigModule.forRoot(
      {
        isGlobal: true,
        cache: true,
        validate: validateEnvironment,
      }
    ),
    UsersModule, DatabaseModule, AuthModule],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    },
    { provide: APP_INTERCEPTOR, useClass: TimeoutInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseTransformInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule{
  configure(consumer: MiddlewareConsumer): void{
    consumer.apply(TraceIdMiddleware,RequestLoggerMiddleware)
    .forRoutes('*');
  }
}
