import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

export function IsFutureDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isFutureDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') {
            return false;
          }
          const timestamp = Date.parse(value);
          if (Number.isNaN(timestamp)) {
            return false;
          }
          return timestamp > Date.now();
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be an ISO-8601 date/time in the future`;
        },
      },
    });
  };
}
