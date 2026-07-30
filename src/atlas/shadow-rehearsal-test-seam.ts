export type ShadowFileWriter = (destinationPath: string, contents: Buffer) => void;

export interface ShadowRehearsalDependencies {
  readonly fileWriter: ShadowFileWriter;
  readonly childScriptPath: string;
  readonly executeRollback: (shadowRoot: string) => void;
}

let override: Partial<ShadowRehearsalDependencies> | undefined;

export function resolveShadowRehearsalDependencies<T extends ShadowRehearsalDependencies>(
  defaults: T,
): T {
  return override ? ({ ...defaults, ...override } as T) : defaults;
}

export function withShadowRehearsalTestOverrides<T>(
  next: Partial<ShadowRehearsalDependencies>,
  fn: () => T,
): T {
  const previous = override;
  override = next;
  try {
    return fn();
  } finally {
    override = previous;
  }
}
