export class DriverError extends Error {
  readonly fix: string;

  constructor(problem: string, fix: string) {
    super(`${problem}\nto fix: ${fix}`);
    this.name = 'DriverError';
    this.fix = fix;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
