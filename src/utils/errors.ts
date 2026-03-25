export class ImapConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapConnectionError';
  }
}

export class AuthenticationError extends Error {
  constructor(message: string = 'Authentication failed. Verify Yahoo App Password.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class EmailNotFoundError extends Error {
  uid: number;
  constructor(uid: number) {
    super(`Email UID ${uid} not found`);
    this.name = 'EmailNotFoundError';
    this.uid = uid;
  }
}

export class InvalidActionError extends Error {
  action: string;
  constructor(action: string, validActions: string[] = []) {
    const valid = validActions.length > 0 ? validActions.join(', ') : '(none loaded)';
    super(`Invalid action: ${action}. Valid actions: ${valid}`);
    this.name = 'InvalidActionError';
    this.action = action;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
