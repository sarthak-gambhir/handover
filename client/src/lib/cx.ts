type ClassArg = string | false | null | undefined;

export function cx(...args: ClassArg[]): string {
  return args.filter(Boolean).join(' ');
}
