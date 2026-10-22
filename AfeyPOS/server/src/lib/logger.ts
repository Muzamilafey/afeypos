import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash', '*.secret', '*.secrets', '*.template', '*.consumerSecret', '*.passkey'],
    censor: '[redacted]',
  },
});
