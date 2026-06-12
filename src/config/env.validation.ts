export class ConfigValidationError extends Error {
    constructor(missingKeys:string[]){
        super(
            `Missing required configuration value(s): ${missingKeys.join(',')}.` +
            `Define then in the enviroment or  in the project .env file.`
        );
        this.name = 'ConfigValidationError';
    }
}

export interface EnviromentVariavles {
    JWT_SECRET: string;
    DATABASE_PATH: string;
    PORT:number;
}

const REQUIRED_KEYS = ['JWT_SECRET', 'DATABASE_PATH'] as const;
const DEFAULT_PORT = 3000;

export function validateEnvironment(
    config: Record<string,unknown>,
): EnviromentVariavles {
    const isMissing = (value: unknown): boolean =>
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim().length === 0);

    const missingKeys = REQUIRED_KEYS.filter((key) => isMissing(config[key]));

    if (missingKeys.length > 0) {
        throw new ConfigValidationError(missingKeys);
    }

    const port = Number(config.PORT ?? DEFAULT_PORT);

    return {
        JWT_SECRET: String(config.JWT_SECRET),
        DATABASE_PATH: String(config.DATABASE_PATH),
        PORT: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    };
}