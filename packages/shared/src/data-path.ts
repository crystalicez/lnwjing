import os from 'node:os';
import path from 'node:path';

export interface DataPathEnvironment {
  readonly LNWJING_DATA_PATH?: string;
  readonly APPDATA?: string;
  readonly USERPROFILE?: string;
  readonly HOME?: string;
  readonly XDG_DATA_HOME?: string;
}

/** Resolve the per-user lnwjing data directory without embedding a developer profile path. */
export function resolveLnwjingDataPath(
  environment: DataPathEnvironment = process.env,
  electronAppData?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const configured = absolutePathOrUndefined(environment.LNWJING_DATA_PATH, pathApi);
  if (configured !== undefined) return configured;

  const home = absolutePathOrUndefined(environment.HOME, pathApi)
    ?? absolutePathOrUndefined(os.homedir(), pathApi);
  if (platform === 'win32') {
    const appData = firstAbsolutePath(
      pathApi,
      environment.APPDATA,
      electronAppData,
      environment.USERPROFILE ? pathApi.join(environment.USERPROFILE, 'AppData', 'Roaming') : undefined,
      home ? pathApi.join(home, 'AppData', 'Roaming') : undefined,
      pathApi.join(os.homedir(), 'AppData', 'Roaming'),
    );
    return pathApi.join(appData, 'lnwjing');
  }

  if (platform === 'darwin') {
    const appData = firstAbsolutePath(
      pathApi,
      electronAppData,
      home ? pathApi.join(home, 'Library', 'Application Support') : undefined,
      pathApi.join(os.homedir(), 'Library', 'Application Support'),
    );
    return pathApi.join(appData, 'lnwjing');
  }

  const appData = firstAbsolutePath(
    pathApi,
    electronAppData,
    environment.XDG_DATA_HOME,
    home ? pathApi.join(home, '.local', 'share') : undefined,
    pathApi.join(os.homedir(), '.local', 'share'),
  );
  return pathApi.join(appData, 'lnwjing');
}

function absolutePathOrUndefined(value: string | undefined, pathApi: typeof path.win32 | typeof path.posix): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || !pathApi.isAbsolute(trimmed)) return undefined;
  return pathApi.normalize(trimmed);
}

function firstAbsolutePath(pathApi: typeof path.win32 | typeof path.posix, ...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const absolute = absolutePathOrUndefined(value, pathApi);
    if (absolute !== undefined) return absolute;
  }
  throw new Error('Unable to resolve an absolute lnwjing data directory');
}
